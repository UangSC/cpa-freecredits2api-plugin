package app

import (
	"context"
	"errors"
	"math"
	"net/http"
	"time"

	"cpa-freecredits2api-plugin/cpasdk/pluginabi"
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/logger"
	"cpa-freecredits2api-plugin/internal/state"
)

const (
	modelCooldownBase        = 30 * time.Minute
	modelCooldownRounds      = 5
	modelCooldownMaxIncrease = 4 * time.Hour
	modelRateLimitRetry      = 10 * time.Second
	modelPauseRetry          = time.Minute
)

type modelAttempt struct {
	fileID         string
	model          string
	startedAt      time.Time
	observeSuccess bool
}

func (a *App) beginModelAttempt(prepared preparedExecution) (modelAttempt, *core.PluginError) {
	fileID := prepared.credential.FileIDValue()
	model := state.ModelCooldownKey(prepared.model)
	if fileID == "" || model == "" || prepared.rpc.AuthID == "" {
		return modelAttempt{}, nil
	}
	now := a.now()
	cooldown := a.store.ModelCooldown(fileID, model)
	if cooldown.Paused {
		return modelAttempt{}, modelRetryError("该凭证的模型已暂停", modelPauseRetry)
	}
	if wait := cooldown.BlockedUntil().Sub(now); wait > 0 {
		return modelAttempt{}, modelRetryError("该凭证的模型仍在冷却中", wait)
	}
	return modelAttempt{
		fileID: fileID, model: model, startedAt: now,
		observeSuccess: !cooldown.Verified || cooldown.Failures > 0 || !cooldown.RateLimitUntil.IsZero(),
	}, nil
}

func modelRetryError(message string, wait time.Duration) *core.PluginError {
	return core.RetryablePluginError(pluginabi.ErrorCodeTransientRateLimit, message, http.StatusTooManyRequests).WithRetryAfter(wait)
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
		if previous.Paused || attempt.startedAt.Before(previous.BlockedUntil()) {
			// 较早的并发成功能证明模型可用，沿用已记录的冷却窗口。
			previous.Verified = true
			return previous
		}
		return state.ModelCooldown{Verified: true, ResetAt: now}
	})
}

// recordModelFailure 记录能让当前上游模型避让的错误。返回空表示沿用原错误。
func (a *App) recordModelFailure(ctx context.Context, attempt modelAttempt, err error) *core.PluginError {
	if attempt.fileID == "" || ctx.Err() != nil {
		return nil
	}
	var failure *core.PluginError
	if !errors.As(core.ToPluginError(err), &failure) || failure == nil || failure.HTTPStatus == http.StatusUnauthorized {
		return nil
	}
	persistent := failure.Code == "upstream_hard_credit" || failure.Code == "upstream_quota" || failure.Code == "upstream_account_fault"
	if !persistent && (failure.HTTPStatus != http.StatusTooManyRequests || !failure.Retryable || failure.Code == pluginabi.ErrorCodeRequestScoped) {
		return nil
	}
	now := a.now()
	seconds := min(int64(failure.RetryAfterSeconds), int64(math.MaxInt64)/int64(time.Second))
	hint := time.Duration(seconds) * time.Second
	rateLimitDelay := hint
	if rateLimitDelay <= 0 {
		rateLimitDelay = modelRateLimitRetry
	}
	cooldown, changed := a.store.UpdateModelCooldown(attempt.fileID, attempt.model, func(previous state.ModelCooldown) state.ModelCooldown {
		if previous.Paused || attempt.startedAt.Before(previous.ResetAt) {
			return previous
		}
		if persistent {
			if attempt.startedAt.Before(previous.RetryAt) {
				return previous
			}
			return advanceModelCooldown(previous, now, hint)
		}
		if !attempt.startedAt.Before(previous.BlockedUntil()) {
			previous.RateLimitUntil = now.Add(rateLimitDelay)
		}
		return previous
	})
	if changed {
		if cooldown.Paused {
			logger.Info("模型连续 %d 次失败后暂停 (credential=%s, model=%s)", cooldown.Failures, core.MaskKey(attempt.fileID), attempt.model)
		} else {
			logger.Info("推理模型冷却 (credential=%s, model=%s, code=%s, retry_at=%s)",
				core.MaskKey(attempt.fileID), attempt.model, failure.Code, cooldown.BlockedUntil().UTC().Format(time.RFC3339))
		}
	}
	wait := max(time.Second, cooldown.BlockedUntil().Sub(now))
	updated := failure.WithRetryAfter(wait)
	updated.Message = streamFailureMessage(err)
	updated.HTTPStatus = http.StatusTooManyRequests
	updated.Retryable = true
	updated.CredentialScoped = false
	if cooldown.Paused {
		updated.RetryAfterSeconds = int(modelPauseRetry / time.Second)
	}
	if cooldown.Paused || updated.Code == "upstream_account_fault" || !cooldown.BlockedUntil().After(now) {
		updated.Code = pluginabi.ErrorCodeTransientRateLimit
	}
	return updated
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
		// 首次使用上游提示，明确的配额失败最少等 10 秒。
		delay = 10 * time.Second
	}
	previous.Failures = min(previous.Failures+1, modelCooldownRounds+1)
	previous.Delay = max(delay, hint)
	previous.RetryAt = now.Add(previous.Delay)
	if !previous.Verified && previous.Failures > modelCooldownRounds {
		previous.Paused = true
		previous.RetryAt = time.Time{}
		previous.RateLimitUntil = time.Time{}
	}
	return previous
}
