package app

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"cpa-freecredits2api-plugin/cpasdk/pluginabi"
	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/hostbridge"
	"cpa-freecredits2api-plugin/internal/logger"
	"cpa-freecredits2api-plugin/internal/state"
)

const (
	modelCooldownBase        = 30 * time.Minute
	modelCooldownRounds      = 5
	modelCooldownMaxIncrease = 4 * time.Hour
	modelPauseRetry          = time.Minute
)

type modelAttempt struct {
	fileID         string
	model          string
	startedAt      time.Time
	token          string
	observeSuccess bool
}

func (a *App) beginModelAttempt(prepared preparedExecution) (modelAttempt, error) {
	fileID := prepared.credential.FileIDValue()
	model := state.ModelCooldownKey(prepared.model)
	if fileID == "" || model == "" || prepared.rpc.AuthID == "" {
		return modelAttempt{}, nil
	}
	now := a.now()
	cooldown := a.store.ModelCooldown(fileID, model)
	if cooldown.Paused {
		return modelAttempt{}, pausedModelError()
	}
	if wait := cooldown.RetryAt.Sub(now); wait > 0 {
		return modelAttempt{}, modelRetryError("该凭证的模型仍在冷却中", wait)
	}
	return modelAttempt{
		fileID: fileID, model: model, startedAt: now, token: prepared.credential.TokenValue(),
		observeSuccess: !cooldown.Verified || cooldown.Failures > 0,
	}, nil
}

func modelRetryError(message string, wait time.Duration) *core.PluginError {
	return core.RetryablePluginError(pluginabi.ErrorCodeTransientRateLimit, message, http.StatusTooManyRequests).WithRetryAfter(wait)
}

func pausedModelError() *core.PluginError {
	return modelRetryError("该凭证的模型已暂停", modelPauseRetry)
}

func (a *App) recordModelSuccess(attempt modelAttempt) {
	if attempt.fileID == "" {
		return
	}
	now := a.now()
	a.store.UpdateModelCooldown(attempt.fileID, attempt.model, func(previous state.ModelCooldown) state.ModelCooldown {
		if attempt.startedAt.Before(previous.ResetAt) {
			return previous
		}
		if attempt.startedAt.Before(previous.RetryAt) {
			// 较早的并发成功能证明模型可用，冷却截止时间沿用新结果。
			previous.Verified = true
			return previous
		}
		return state.ModelCooldown{Verified: true, ResetAt: now}
	})
}

func (a *App) recordModelFailure(ctx context.Context, prepared preparedExecution, attempt modelAttempt, err error) error {
	if attempt.fileID == "" || ctx.Err() != nil {
		return err
	}
	var failure *core.PluginError
	if !errors.As(core.ToPluginError(err), &failure) || failure == nil || failure.HTTPStatus == http.StatusUnauthorized {
		return err
	}
	switch failure.Code {
	case "upstream_hard_credit", "upstream_quota", "upstream_account_fault":
	default:
		return err
	}
	now := a.now()
	seconds := min(int64(failure.RetryAfterSeconds), int64(math.MaxInt64)/int64(time.Second))
	hint := time.Duration(seconds) * time.Second
	cooldown, changed := a.store.UpdateModelCooldown(attempt.fileID, attempt.model, func(previous state.ModelCooldown) state.ModelCooldown {
		if previous.Paused || attempt.startedAt.Before(previous.RetryAt) || attempt.startedAt.Before(previous.ResetAt) {
			// 同一轮已经失败，冷却期间的并发结果不增加次数或延长窗口。
			return previous
		}
		return advanceModelCooldown(previous, now, hint)
	})
	if cooldown.Paused {
		return pausedModelError()
	}
	if !changed && attempt.startedAt.Before(cooldown.ResetAt) {
		return modelRetryError(streamFailureMessage(err), time.Second)
	}
	if !cooldown.Verified && cooldown.Failures > modelCooldownRounds {
		if !changed {
			return modelRetryError("该凭证的模型仍在冷却中", modelPauseRetry)
		}
		if stopped := a.stopUnverifiedModel(ctx, prepared, attempt, cooldown); stopped != nil {
			return stopped
		}
		cooldown = a.store.ModelCooldown(attempt.fileID, attempt.model)
	}
	if wait := max(hint, cooldown.RetryAt.Sub(a.now())); wait > 0 {
		updated := failure.WithRetryAfter(wait)
		updated.Message = streamFailureMessage(err)
		updated.HTTPStatus = http.StatusTooManyRequests
		updated.Retryable = true
		if updated.Code == "upstream_account_fault" {
			updated.Code = pluginabi.ErrorCodeTransientRateLimit
		}
		return updated
	}
	return err
}

func advanceModelCooldown(previous state.ModelCooldown, now time.Time, hint time.Duration) state.ModelCooldown {
	delay := modelCooldownBase
	switch {
	case previous.Failures > 0 && previous.Delay > 0:
		delay = previous.Delay
		if previous.Failures < modelCooldownRounds {
			delay += min(delay, modelCooldownMaxIncrease, time.Duration(math.MaxInt64)-delay)
		}
	case hint > 0:
		// 首次采用上游提示，并应用 CPA 的普通额度冷却下限。
		delay = 10 * time.Second
	}
	delay = max(delay, hint)
	return state.ModelCooldown{
		Failures: min(previous.Failures+1, modelCooldownRounds+1),
		Delay:    delay,
		RetryAt:  now.Add(delay),
		Verified: previous.Verified,
		ResetAt:  previous.ResetAt,
	}
}

func (a *App) stopUnverifiedModel(ctx context.Context, prepared preparedExecution, attempt modelAttempt, cooldown state.ModelCooldown) error {
	ctx, cancel := context.WithTimeout(ctx, credentialStateSyncTimeout)
	defer cancel()
	entry, latest, raw, ok := a.currentCredentialState(ctx, prepared)
	if ctx.Err() != nil || (ok && (latest.TokenValue() != attempt.token || !sameCredentialStateIdentity(prepared.credential, latest))) {
		return nil
	}
	if !ok || !a.isOnlyRegisteredModel(ctx, prepared, entry) {
		if ctx.Err() == nil && a.pauseModel(attempt, cooldown) {
			return pausedModelError()
		}
		return nil
	}
	if entry.Success > 0 && !entry.Disabled {
		// 只有一个已启用模型时，CPA 的凭证级成功计数可以用于保守保护。
		a.store.UpdateModelCooldown(attempt.fileID, attempt.model, func(current state.ModelCooldown) state.ModelCooldown {
			if current == cooldown {
				current.Verified = true
			}
			return current
		})
		return nil
	}
	if ctx.Err() != nil || a.store.ModelCooldown(attempt.fileID, attempt.model) != cooldown {
		return nil
	}
	credentialLabel := core.MaskKey(attempt.fileID)
	if !entry.Disabled {
		if err := a.admin.SaveAuthDisabled(prepared.rpc.HostCallbackID, entry, raw, entry.Path, true); err != nil {
			logger.Info("单模型凭证自动停用延后 (credential=%s, model=%s)", credentialLabel, attempt.model)
			return nil
		}
		logger.Info("单模型凭证连续 %d 次失败后自动停用 (credential=%s, model=%s)", cooldown.Failures, credentialLabel, attempt.model)
	}
	a.store.UpdateModelCooldown(attempt.fileID, attempt.model, func(current state.ModelCooldown) state.ModelCooldown {
		if current == cooldown {
			return state.ModelCooldown{}
		}
		return current
	})
	return core.RetryablePluginError("single_model_credential_disabled", "唯一启用的模型连续失败，凭证已停用", http.StatusTooManyRequests)
}

func (a *App) pauseModel(attempt modelAttempt, cooldown state.ModelCooldown) bool {
	_, changed := a.store.UpdateModelCooldown(attempt.fileID, attempt.model, func(current state.ModelCooldown) state.ModelCooldown {
		if current == cooldown {
			current.Paused = true
			current.RetryAt = time.Time{}
		}
		return current
	})
	if changed {
		logger.Info("模型连续 %d 次失败后暂停 (credential=%s, model=%s)", cooldown.Failures, core.MaskKey(attempt.fileID), attempt.model)
	}
	return changed
}

func (a *App) isOnlyRegisteredModel(ctx context.Context, prepared preparedExecution, entry core.HostAuth) bool {
	if entry.AuthIndex == "" {
		return false
	}
	ctx = hostbridge.WithCallbackID(ctx, prepared.rpc.HostCallbackID)
	raw, err := hostbridge.CallCtx(ctx, pluginabi.MethodHostAuthModels, pluginapi.HostAuthModelsRequest{AuthIndex: entry.AuthIndex})
	var response pluginapi.HostAuthModelsResponse
	if err != nil || json.Unmarshal(raw, &response) != nil || len(response.Credentials) != 1 {
		return false
	}
	registered := response.Credentials[0]
	if registered.AuthIndex != entry.AuthIndex || registered.ID != entry.ID || registered.Provider != providerKey {
		return false
	}
	enabledID := ""
	for _, model := range registered.Models {
		_, bare := a.registry.SplitModelID(model)
		resolved := a.resolveOutboundModel(prepared.vendor.ID(), bare)
		if a.isModelDisabled(prepared.vendor.ID(), resolved) {
			continue
		}
		if !strings.EqualFold(resolved, prepared.model) {
			return false
		}
		if enabledID != "" && !strings.EqualFold(enabledID, model) {
			return false
		}
		enabledID = model
	}
	return enabledID != ""
}
