package app

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sort"
	"strings"
	"time"

	"cpa-freecredits2api-plugin/cpasdk/pluginabi"
	"cpa-freecredits2api-plugin/internal/admin"
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/state"
)

func (a *App) prepareModelRoute(prepared preparedExecution, requested string) (preparedExecution, error) {
	vendorID := prepared.vendor.ID()
	candidates, known := a.models.CredentialCandidates(prepared.credential.FileIDValue(), vendorID, requested)
	if len(candidates) == 0 {
		model := a.resolveOutboundModel(vendorID, requested)
		// 宿主还可能使用额外模型或旧版清单。没有凭证专属清单时沿用单目标解析。
		if known && !a.isExtraRoute(vendorID, model) {
			return prepared, core.RetryablePluginError("upstream_model_blocked", "该凭证没有注册请求的模型", http.StatusNotFound)
		}
		candidates = []admin.ModelCandidate{{ID: model, Disabled: a.isModelDisabled(vendorID, model)}}
	}
	if len(candidates) > 1 {
		// 同等级先洗牌，再稳定地将高优先级放在前面。
		rand.Shuffle(len(candidates), func(i, j int) { candidates[i], candidates[j] = candidates[j], candidates[i] })
		sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].Priority > candidates[j].Priority })
	}
	for _, candidate := range candidates {
		if !candidate.Disabled {
			prepared.models = append(prepared.models, candidate.ID)
		}
	}
	if len(prepared.models) == 0 {
		return prepared, core.NewPluginError("model_disabled",
			fmt.Sprintf("model %q is disabled by plugin configuration", prepared.rpc.Model), http.StatusBadRequest)
	}
	return a.executionForModel(prepared, prepared.models[0]), nil
}

func (a *App) isExtraRoute(vendorID, modelID string) bool {
	for _, model := range a.models.ExtraModels() {
		if (model.OwnedBy == "" || model.OwnedBy == vendorID) && strings.EqualFold(model.ID, modelID) {
			return true
		}
	}
	return false
}

func (a *App) executionForModel(prepared preparedExecution, model string) preparedExecution {
	prepared.model = model
	prepared.contextLength = a.models.ContextLengthFor(prepared.vendor.ID(), model)
	return prepared
}

// executeModelRoute 是流式和非流式的共同回退入口。已投递流数据的请求只记录失败，
// 以免把另一个模型的输出接到已开始的对话中。
func (a *App) executeModelRoute(ctx context.Context, prepared preparedExecution,
	execute func(preparedExecution, modelAttempt) (emitted bool, err error)) error {
	var lastFailure *core.PluginError
	for i, model := range prepared.models {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if i > 0 {
			prepared = a.executionForModel(prepared, model)
		}
		attempt, blocked := a.beginModelAttempt(prepared)
		if blocked != nil {
			if lastFailure == nil {
				lastFailure = blocked
			}
			continue
		}
		emitted, err := execute(prepared, attempt)
		if err == nil {
			return nil
		}
		lastFailure = a.recordModelFailure(ctx, attempt, err)
		if lastFailure == nil {
			return err
		}
		if emitted {
			break
		}
	}
	return a.routeCooldown(prepared, lastFailure)
}

func (a *App) routeCooldown(prepared preparedExecution, failure *core.PluginError) error {
	fileID := prepared.credential.FileIDValue()
	now := a.now()
	cooldowns := a.store.CredentialModelCooldowns(fileID)
	if retryAt, paused, all := state.AllModelsBlocked(a.models.EnabledCredentialModelIDs(fileID), cooldowns, now); all {
		result := failure.WithRetryAfter(modelRouteWait(now, retryAt, paused))
		result.CredentialScoped = true
		return result
	}
	if retryAt, paused, all := state.AllModelsBlocked(prepared.models, cooldowns, now); all {
		return failure.WithRetryAfter(modelRouteWait(now, retryAt, paused))
	}
	// 同一对外 ID 还有可用目标时，终止这次已开始的流，同时保留后续请求的路由。
	return core.NewPluginError(pluginabi.ErrorCodeRequestScoped, failure.Message, failure.HTTPStatus)
}

func modelRouteWait(now, retryAt time.Time, paused bool) time.Duration {
	if retryAt.IsZero() {
		return modelPauseRetry
	}
	wait := retryAt.Sub(now)
	if paused {
		// 暂停可能随时被手动解除，让 CPA 定期重新检查路由。
		return min(wait, modelPauseRetry)
	}
	return wait
}
