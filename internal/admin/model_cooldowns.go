package admin

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"cpa-freecredits2api-plugin/cpasdk/pluginabi"
	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/hostbridge"
	"cpa-freecredits2api-plugin/internal/logger"
	"cpa-freecredits2api-plugin/internal/state"
)

type modelCooldownStatus struct {
	FileID   string     `json:"file_id"`
	Model    string     `json:"model"`
	Failures int        `json:"failures"`
	Verified bool       `json:"verified"`
	Paused   bool       `json:"paused"`
	Active   bool       `json:"active"`
	RetryAt  *time.Time `json:"retry_at,omitempty"`
}

type credentialCooldownStatus struct {
	FileID     string     `json:"file_id"`
	ModelCount int        `json:"model_count"`
	RetryAt    *time.Time `json:"retry_at,omitempty"`
}

func (s *Service) handleModelCooldowns() pluginapi.ManagementResponse {
	now := time.Now()
	cooldowns := s.deps.State().ModelCooldowns
	rows := make([]modelCooldownStatus, 0)
	for fileID, models := range cooldowns {
		for model, cooldown := range models {
			until := cooldown.BlockedUntil()
			active := cooldown.Paused || until.After(now)
			if cooldown.Failures == 0 && !active {
				continue
			}
			row := modelCooldownStatus{
				FileID: fileID, Model: model, Failures: cooldown.Failures,
				Verified: cooldown.Verified, Paused: cooldown.Paused, Active: active,
			}
			if !until.IsZero() {
				row.RetryAt = &until
			}
			rows = append(rows, row)
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].FileID != rows[j].FileID {
			return rows[i].FileID < rows[j].FileID
		}
		return rows[i].Model < rows[j].Model
	})
	return JSONResponse(http.StatusOK, map[string]any{"models": rows, "credentials": s.coolingCredentials(cooldowns, now)})
}

func (s *Service) coolingCredentials(cooldowns map[string]map[string]state.ModelCooldown, now time.Time) []credentialCooldownStatus {
	rows := make([]credentialCooldownStatus, 0)
	for fileID, models := range cooldowns {
		enabled := s.deps.Model().EnabledCredentialModelIDs(fileID)
		retryAt, _, all := state.AllModelsBlocked(enabled, models, now)
		if !all {
			continue
		}
		row := credentialCooldownStatus{FileID: fileID, ModelCount: len(enabled)}
		if !retryAt.IsZero() {
			row.RetryAt = &retryAt
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].FileID < rows[j].FileID })
	return rows
}

// releaseCredentialCooldowns 解除管理操作已恢复可用的凭证在 CPA 上的等待。
// CPA 的回调重置该凭证的路由状态，插件会继续在出站前拦截仍处于冷却的模型。
// 返回值表示有已恢复的凭证尚未确认同步。
func (s *Service) releaseCredentialCooldowns(req pluginapi.ManagementRequest, previous []credentialCooldownStatus) bool {
	if len(previous) == 0 {
		return false
	}
	now := time.Now()
	cooldowns := s.deps.State().ModelCooldowns
	recovered := make(map[string]bool)
	for _, credential := range previous {
		enabled := s.deps.Model().EnabledCredentialModelIDs(credential.FileID)
		if _, _, all := state.AllModelsBlocked(enabled, cooldowns[credential.FileID], now); len(enabled) > 0 && !all {
			recovered[credential.FileID] = true
		}
	}
	return s.resetHostRoutingCooldowns(req, recovered)
}

// coolingAliasCredentials 找出该对外 ID 在哪些凭证上已经没有可用的候选模型。
func (s *Service) coolingAliasCredentials(vendorID, alias string) map[string]bool {
	now := time.Now()
	blocked := make(map[string]bool)
	for fileID, cooldowns := range s.deps.State().ModelCooldowns {
		candidates, _ := s.deps.Model().CredentialCandidates(fileID, vendorID, alias)
		models := make([]string, 0, len(candidates))
		for _, candidate := range candidates {
			if !candidate.Disabled {
				models = append(models, candidate.ID)
			}
		}
		if _, _, all := state.AllModelsBlocked(models, cooldowns, now); all {
			blocked[fileID] = true
		}
	}
	return blocked
}

func (s *Service) resetHostRoutingCooldowns(req pluginapi.ManagementRequest, recovered map[string]bool) bool {
	if len(recovered) == 0 {
		return false
	}
	ctx, cancel := hostbridge.ManagementContext(req, 5*time.Second)
	defer cancel()
	auths, err := hostbridge.ListAuths(ctx, hostbridge.RequestCallbackID(req), s.registry)
	if err != nil {
		logger.Info("冷却同步等待下次恢复：读取 CPA 凭证失败：%v", err)
		return true
	}
	for _, entry := range auths {
		fileID := hostbridge.AccountIdentity(entry)
		if !recovered[fileID] || entry.Disabled || entry.Provider != core.ProviderKey || entry.AuthIndex == "" {
			continue
		}
		if _, err := hostbridge.CallCtx(ctx, pluginabi.MethodHostRoutingResetCooldown,
			pluginapi.HostRoutingResetCooldownRequest{AuthIndex: entry.AuthIndex}); err != nil {
			logger.Info("CPA 凭证冷却同步失败 (credential=%s): %v", core.MaskKey(fileID), err)
			continue
		}
		delete(recovered, fileID)
	}
	return len(recovered) > 0
}

type modelResumeRequest struct {
	FileID string `json:"file_id"`
	Model  string `json:"model"`
}

func (s *Service) handleModelResume(req pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	body, err := decodeRequest[modelResumeRequest](req.Body)
	if err != nil {
		return BadJSONRequestResponse()
	}
	fileID := strings.TrimSpace(body.FileID)
	model := state.ModelCooldownKey(body.Model)
	if fileID == "" || model == "" {
		return JSONResponse(http.StatusBadRequest, map[string]any{"ok": false, "error": "file_id 和 model 不能为空"})
	}
	changed := false
	resetAt := time.Now()
	before := s.deps.State().ModelCooldowns[fileID]
	previous := s.coolingCredentials(map[string]map[string]state.ModelCooldown{fileID: before}, resetAt)
	if errSave := s.deps.SaveStateChange(func(current *state.State) {
		models := current.ModelCooldowns[fileID]
		if models[model].Paused {
			// 保留恢复时间，忽略恢复前已经发出的并发请求的旧失败。
			models[model] = state.ModelCooldown{ResetAt: resetAt}
			changed = true
		}
	}); errSave != nil {
		return JSONResponse(http.StatusInternalServerError, map[string]any{"ok": false, "error": "无法保存模型恢复状态"})
	}
	return JSONResponse(http.StatusOK, map[string]any{
		"ok": true, "changed": changed, "cooldown_sync_pending": changed && s.releaseCredentialCooldowns(req, previous),
	})
}
