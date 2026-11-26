package admin

import (
	"fmt"
	"strings"

	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/state"
)

const MaxModelPriority = 9

type credentialModelSet struct {
	vendorID  string
	models    []pluginapi.ModelInfo
	confirmed bool
}

// ModelCandidate 代表一条凭证能执行的实际模型及其渠道内优先级。
type ModelCandidate struct {
	ID       string
	Priority int
	Disabled bool
}

func (c *Catalog) ModelPriority(vendorID, modelID string) int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.priorities[strings.ToLower(aliasScopedKey(vendorID, modelID))]
}

func (c *Catalog) SetModelPriority(vendorID, modelID string, priority int) error {
	if priority < 0 || priority > MaxModelPriority {
		return fmt.Errorf("model priority is outside 0–%d", MaxModelPriority)
	}
	if c.store == nil {
		return fmt.Errorf("model state store is unavailable")
	}
	key := strings.ToLower(aliasScopedKey(vendorID, modelID))
	c.mu.Lock()
	defer c.mu.Unlock()
	if priority == c.priorities[key] {
		return nil
	}
	if err := c.store.MutateAndSave(func(s *state.State) {
		// 归一旧渠道键，设为 0 时也能真正清除旧值。
		for stored := range s.ModelPriorities {
			if strings.EqualFold(c.canonicalAliasKey(stored), key) {
				delete(s.ModelPriorities, stored)
			}
		}
		if priority > 0 {
			if s.ModelPriorities == nil {
				s.ModelPriorities = make(map[string]int)
			}
			s.ModelPriorities[key] = priority
		}
	}); err != nil {
		return err
	}
	if priority == 0 {
		delete(c.priorities, key)
	} else {
		c.priorities[key] = priority
	}
	return nil
}

// RememberCredentialModels 保留该凭证在别名合并前的上游清单。供应商缓存可用于
// 注册回退，但只有凭证自身探测成功的清单能用于判断整条凭证是否冷却。
func (c *Catalog) RememberCredentialModels(fileID, vendorID string, models []pluginapi.ModelInfo, confirmed bool) {
	if fileID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(models) == 0 {
		delete(c.credentialModels, fileID)
		return
	}
	c.credentialModels[fileID] = credentialModelSet{vendorID, append([]pluginapi.ModelInfo(nil), models...), confirmed}
}

func (c *Catalog) CredentialModels(fileID, vendorID string) ([]pluginapi.ModelInfo, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	set := c.credentialModels[fileID]
	if set.vendorID != vendorID {
		return nil, false
	}
	return append([]pluginapi.ModelInfo(nil), set.models...), set.confirmed
}

// CredentialCandidates 用合并前的清单反查对外 ID。返回值 found 表示已知凭证
// 清单，候选为空时调用方可以明确拒绝该凭证未注册的模型。
func (c *Catalog) CredentialCandidates(fileID, vendorID, requested string) (candidates []ModelCandidate, found bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	set, found := c.credentialModels[fileID]
	if !found || set.vendorID != vendorID {
		return nil, false
	}
	present := make(map[string]bool, len(set.models))
	for _, model := range set.models {
		if id := strings.TrimSpace(model.ID); !c.modelDisabledLocked(vendorID, id) {
			present[strings.ToLower(id)] = true
		}
	}
	seen := make(map[string]bool)
	for _, model := range set.models {
		id := strings.TrimSpace(model.ID)
		key := strings.ToLower(id)
		if id != "" && !seen[key] && strings.EqualFold(c.publicModelIDLocked(vendorID, id, present), requested) {
			seen[key] = true
			candidates = append(candidates, c.modelCandidateLocked(vendorID, id))
		}
	}
	if len(candidates) != 0 {
		return candidates, true
	}
	// CPA 可能已还原官方 ID，旧客户端也可能还在使用历史渠道标识。
	for _, legacy := range append([]string{requested}, c.untagModelID(vendorID, requested)...) {
		for _, model := range set.models {
			if id := strings.TrimSpace(model.ID); strings.EqualFold(id, legacy) {
				return []ModelCandidate{c.modelCandidateLocked(vendorID, id)}, true
			}
		}
	}
	return nil, true
}

func (c *Catalog) modelCandidateLocked(vendorID, id string) ModelCandidate {
	return ModelCandidate{
		ID: id, Priority: c.priorities[strings.ToLower(aliasScopedKey(vendorID, id))],
		Disabled: c.modelDisabledLocked(vendorID, id),
	}
}

// EnabledCredentialModelIDs 返回最近一次由该凭证确认、且当前仍启用的上游 ID。
func (c *Catalog) EnabledCredentialModelIDs(fileID string) []string {
	c.mu.RLock()
	set := c.credentialModels[fileID]
	if !set.confirmed {
		c.mu.RUnlock()
		return nil
	}
	vendor, ok := c.registry.ByID(set.vendorID)
	if !ok || !core.RealmEnabled(c.settings.EnabledRealms, vendor.Region()) {
		c.mu.RUnlock()
		return nil
	}
	ids := make([]string, 0, len(set.models))
	seen := make(map[string]bool, len(set.models))
	for _, model := range set.models {
		id := strings.TrimSpace(model.ID)
		key := state.ModelCooldownKey(id)
		if key != "" && !seen[key] && !c.modelDisabledLocked(set.vendorID, id) {
			ids = append(ids, key)
			seen[key] = true
		}
	}
	includeExtras := len(c.settings.ExtraModels) > 0
	c.mu.RUnlock()
	if includeExtras {
		for _, extra := range c.ExtraModels() {
			key := state.ModelCooldownKey(extra.ID)
			if extra.OwnedBy == set.vendorID && !seen[key] {
				ids = append(ids, key)
				seen[key] = true
			}
		}
	}
	return ids
}
