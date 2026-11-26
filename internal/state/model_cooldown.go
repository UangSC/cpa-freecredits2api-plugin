package state

import (
	"maps"
	"strings"
	"time"
)

// ModelCooldown 保存同一凭证下一个模型的退避与恢复状态。
type ModelCooldown struct {
	Failures       int           `json:"failures,omitempty"`
	Delay          time.Duration `json:"delay_ns,omitempty"`
	RetryAt        time.Time     `json:"retry_at,omitempty"`
	RateLimitUntil time.Time     `json:"rate_limit_until,omitempty"`
	Verified       bool          `json:"verified,omitempty"`
	Paused         bool          `json:"paused,omitempty"`
	ResetAt        time.Time     `json:"reset_at,omitempty"`
}

// BlockedUntil 合并持久配额退避和临时限流的截止时间。
func (c ModelCooldown) BlockedUntil() time.Time {
	if c.RateLimitUntil.After(c.RetryAt) {
		return c.RateLimitUntil
	}
	return c.RetryAt
}

// AllModelsBlocked 只在非空集合里的所有模型均冷却或暂停时返回 true。
// retryAt 是最早的自动恢复时间，全为暂停状态时为空。
func AllModelsBlocked(models []string, cooldowns map[string]ModelCooldown, now time.Time) (retryAt time.Time, hasPaused, blocked bool) {
	for _, id := range models {
		cooldown := cooldowns[ModelCooldownKey(id)]
		if cooldown.Paused {
			hasPaused = true
			continue
		}
		until := cooldown.BlockedUntil()
		if !until.After(now) {
			return time.Time{}, false, false
		}
		if retryAt.IsZero() || until.Before(retryAt) {
			retryAt = until
		}
	}
	return retryAt, hasPaused, len(models) > 0
}

// ModelCooldownKey 统一上游模型 ID 的比较方式。
func ModelCooldownKey(model string) string {
	return strings.ToLower(strings.TrimSpace(model))
}

// ModelCooldown 读取一个模型的状态，避免在推理热路径复制整份状态。
func (s *Store) ModelCooldown(fileID, model string) ModelCooldown {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		return ModelCooldown{}
	}
	return s.cache.ModelCooldowns[fileID][model]
}

// CredentialModelCooldowns 读取一条凭证的冷却状态快照，供路由汇总使用。
func (s *Store) CredentialModelCooldowns(fileID string) map[string]ModelCooldown {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		return nil
	}
	return maps.Clone(s.cache.ModelCooldowns[fileID])
}

// UpdateModelCooldown 原子更新单条状态，实际变化时安排写盘。
func (s *Store) UpdateModelCooldown(fileID, model string, update func(ModelCooldown) ModelCooldown) (ModelCooldown, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		s.cache = New()
	}
	models := s.cache.ModelCooldowns[fileID]
	previous := models[model]
	next := update(previous)
	if next == previous {
		return next, false
	}
	if next == (ModelCooldown{}) {
		delete(models, model)
		if len(models) == 0 {
			delete(s.cache.ModelCooldowns, fileID)
		}
	} else {
		if s.cache.ModelCooldowns == nil {
			s.cache.ModelCooldowns = make(map[string]map[string]ModelCooldown)
		}
		if models == nil {
			models = make(map[string]ModelCooldown)
			s.cache.ModelCooldowns[fileID] = models
		}
		models[model] = next
	}
	s.scheduleSaveLocked()
	return next, true
}
