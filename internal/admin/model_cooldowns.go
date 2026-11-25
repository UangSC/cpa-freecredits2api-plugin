package admin

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/state"
)

type modelCooldownStatus struct {
	FileID   string     `json:"file_id"`
	Model    string     `json:"model"`
	Failures int        `json:"failures"`
	Verified bool       `json:"verified"`
	Paused   bool       `json:"paused"`
	RetryAt  *time.Time `json:"retry_at,omitempty"`
}

func (s *Service) handleModelCooldowns() pluginapi.ManagementResponse {
	rows := make([]modelCooldownStatus, 0)
	for fileID, models := range s.deps.State().ModelCooldowns {
		for model, cooldown := range models {
			if cooldown.Failures == 0 && !cooldown.Paused {
				continue
			}
			row := modelCooldownStatus{
				FileID: fileID, Model: model, Failures: cooldown.Failures,
				Verified: cooldown.Verified, Paused: cooldown.Paused,
			}
			if !cooldown.RetryAt.IsZero() {
				row.RetryAt = &cooldown.RetryAt
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
	return JSONResponse(http.StatusOK, map[string]any{"models": rows})
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
	return JSONResponse(http.StatusOK, map[string]any{"ok": true, "changed": changed})
}
