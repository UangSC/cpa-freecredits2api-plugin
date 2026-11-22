package tasks

// 本文件是任务引擎对管理层的稳定 API：返回可直接 JSON 序列化的结果。

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/safe"
)

// QueueRequest 是「启动任务队列」的请求参数。
//
// 解析放在管理接口层（tasks 不得依赖 admin）：本包只接收已解析的参数，
// 不再自己解 JSON——那会让畸形请求静默退化成默认队列。
type QueueRequest struct {
	Concurrency int      `json:"concurrency"`
	Growth      bool     `json:"growth"`
	School      bool     `json:"school"`
	Kinds       []string `json:"kinds,omitempty"`
	ModuleIDs   []string `json:"module_ids,omitempty"`
	VendorIDs   []string `json:"vendor_ids,omitempty"`
}

// ScanOptions 限定扫描涉及的渠道和模块。空列表表示扫描全部。
type ScanOptions struct {
	VendorIDs []string `json:"vendor_ids,omitempty"`
	ModuleIDs []string `json:"module_ids,omitempty"`
}

// DefaultQueueRequest 是请求体缺省时的队列参数（旧控制台的默认行为）。
func DefaultQueueRequest() QueueRequest {
	return QueueRequest{Concurrency: 1, Growth: true, School: true}
}

// Scan 按指定范围扫描账号待办任务。
func (s *Service) Scan(ctx context.Context, callbackID string, opts ScanOptions) map[string]any {
	scans := s.scanAccounts(ctx, callbackID, stringSet(opts.VendorIDs), stringSet(opts.ModuleIDs))
	total := 0
	for _, scan := range scans {
		total += len(scan.Tasks)
	}
	return map[string]any{"ok": true, "accounts": scans, "pending_count": total, "modules": s.ModuleMetas()}
}

// QueueSnapshot 返回任务队列快照。
func (s *Service) QueueSnapshot() map[string]any { return s.taskQueueSnapshot() }

// StartQueue 按已解析的参数启动任务队列。
func (s *Service) StartQueue(ctx context.Context, request QueueRequest, callbackID string) (map[string]any, int) {
	concurrency := request.Concurrency
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > queueMaxConcurrency {
		concurrency = queueMaxConcurrency
	}
	// 新版支持显式传 kinds / module_ids / vendor_ids；
	// 仅传旧版 growth/school 且两者不同时才限定到对应任务族，两者同开或同关均执行全部扫描到的任务族。
	selectedKinds := stringSet(request.Kinds)
	if len(selectedKinds) == 0 && request.Growth != request.School {
		selectedKinds = map[string]bool{}
		if request.Growth {
			selectedKinds["growth"] = true
		}
		if request.School {
			selectedKinds["school"] = true
		}
	}
	selectedVendors := stringSet(request.VendorIDs)
	selectedModules := stringSet(request.ModuleIDs)

	s.queue.mu.Lock()
	if s.queue.running || s.queue.preparing {
		result := map[string]any{"ok": false, "error": "队列正在准备或执行中"}
		if s.queue.running {
			result["seq"] = s.queue.seq
		}
		s.queue.mu.Unlock()
		return result, http.StatusConflict
	}
	s.queue.preparing = true
	s.queue.mu.Unlock()
	committed := false
	defer func() {
		if !committed {
			s.queue.mu.Lock()
			s.queue.preparing = false
			s.queue.mu.Unlock()
		}
	}()

	scans := s.scanAccounts(ctx, callbackID, selectedVendors, selectedModules)
	if ctx.Err() != nil {
		return map[string]any{"ok": false, "error": "扫描已取消或超时"}, http.StatusRequestTimeout
	}

	items := s.buildQueueItemsFiltered(scans, selectedKinds, selectedModules)
	if len(items) == 0 {
		for _, scan := range scans {
			if scan.Error != "" {
				return map[string]any{"ok": false, "error": "扫描待办失败：" + scan.Error}, http.StatusBadGateway
			}
		}
		return map[string]any{"ok": true, "started": false, "message": "当前范围没有待办任务"}, http.StatusOK
	}

	s.queue.mu.Lock()
	s.queue.preparing = false
	s.queue.running = true
	s.queue.seq++
	s.queue.conc = concurrency
	s.queue.startedAt = s.deps.Now()
	s.queue.items = items
	seq := s.queue.seq
	s.queue.mu.Unlock()
	committed = true
	s.trackJob(func(jobCtx context.Context) { s.runQueueItems(jobCtx, concurrency, seq) })
	return map[string]any{"ok": true, "started": true, "total": len(items), "seq": seq, "concurrency": concurrency}, http.StatusOK
}

// RunAuto 对单个账号执行单任务或一键完成。
func (s *Service) RunAuto(ctx context.Context, callbackID, identifier, code string) (map[string]any, int) {
	return s.RunAutoModule(ctx, callbackID, identifier, code, "")
}

// RunAutoModule 对单个账号执行指定模块/任务码或该账号全部任务模块。
func (s *Service) RunAutoModule(ctx context.Context, callbackID, identifier, code, moduleID string) (map[string]any, int) {
	moduleID = strings.TrimSpace(moduleID)
	account := s.findAccount(ctx, callbackID, identifier)
	if account == nil {
		return map[string]any{"ok": false, "error": "账号不存在"}, http.StatusNotFound
	}
	if !s.tryLockAccount(account.uid()) {
		return map[string]any{"ok": false, "error": "该账号有任务动作正在执行中"}, http.StatusConflict
	}
	defer s.unlockAccount(account.uid())

	if strings.TrimSpace(code) == "" {
		if s.modules != nil {
			if moduleID != "" {
				if _, ok := s.modules.ByID(moduleID); !ok {
					return map[string]any{"ok": false, "error": "任务模块不存在"}, http.StatusNotFound
				}
			}
			mods := s.matchingAutoModules(account, stringSet([]string{moduleID}))
			if len(mods) == 0 {
				return map[string]any{"ok": true, "results": []autoAllResult{}, "message": "该账号没有匹配的可执行任务模块"}, http.StatusOK
			}
			return map[string]any{"ok": true, "results": s.runAutoModules(ctx, account, mods)}, http.StatusOK
		}
		return map[string]any{"ok": true, "results": s.runAutoAll(ctx, account)}, http.StatusOK
	}
	result, errRun := s.runTaskForAccountWithModule(ctx, account, code, moduleID)
	if errRun != nil {
		return map[string]any{"ok": false, "error": errRun.Error(), "task_code": code}, http.StatusOK
	}
	payload := map[string]any{
		"ok": result.Status != core.AutoStatusError, "task_code": code, "message": result.Message, "status": result.Status,
		"credit": result.Credit, "energy": result.Energy,
	}
	if result.Status == core.AutoStatusError {
		payload["error"] = core.FirstNonEmpty(result.Message, "任务执行失败")
	}
	return payload, http.StatusOK
}

// RunAutoAll 对指定账号（targets 为空表示全部）依次执行一键完成。
//
// 这是同步版本，只给测试与内部调用；管理接口走后台任务（见 StartAutoAll）。
func (s *Service) RunAutoAll(ctx context.Context, callbackID string, targets []string) map[string]any {
	return s.runAutoAllWithOptions(ctx, callbackID, AutoAllOptions{AccountIDs: targets}, nil)
}

// runAutoAllWithOptions 按可选的账号/渠道/模块范围串行跑完一键任务，onProgress 在每个账号开始前回报进度。
func (s *Service) runAutoAllWithOptions(ctx context.Context, callbackID string, opts AutoAllOptions, onProgress func(done, total int)) map[string]any {
	loaded := s.collectAccounts(ctx, callbackID, opts.AccountIDs)
	vendorFilter := stringSet(opts.VendorIDs)
	moduleFilter := stringSet(opts.ModuleIDs)
	if len(vendorFilter) > 0 {
		filtered := make([]*accountContext, 0, len(loaded))
		for _, account := range loaded {
			if vendorFilter[account.vendor.ID()] {
				filtered = append(filtered, account)
			}
		}
		loaded = filtered
	}
	explicitTargets := len(opts.AccountIDs) > 0
	if s.modules != nil && !explicitTargets {
		// 非点名执行时直接隔离无任务模块或未命中筛选模块的账号，
		// 避免把无任务渠道混进一键任务的进度分母与结果列表。
		eligible := make([]*accountContext, 0, len(loaded))
		for _, account := range loaded {
			if len(s.matchingAutoModules(account, moduleFilter)) > 0 {
				eligible = append(eligible, account)
			}
		}
		loaded = eligible
	}
	if len(loaded) == 0 {
		return map[string]any{"ok": true, "accounts": 0, "tasks_done": 0, "results": []any{}, "message": "没有匹配的可执行任务账号"}
	}
	type accountResult struct {
		Label    string          `json:"label"`
		UID      string          `json:"uid"`
		VendorID string          `json:"vendor_id,omitempty"`
		Realm    string          `json:"realm"`
		Skipped  string          `json:"skipped,omitempty"`
		Results  []autoAllResult `json:"results,omitempty"`
	}
	out := make([]accountResult, 0, len(loaded))
	cancelled := false
	for index, account := range loaded {
		// 关停时 ctx 会先被取消：不要在卸载插件的路上再起一次上游请求。
		if ctx.Err() != nil {
			cancelled = true
			break
		}
		if onProgress != nil {
			onProgress(index, len(loaded))
		}
		entry := accountResult{
			Label:    account.label(),
			UID:      account.uid(),
			VendorID: account.vendor.ID(),
			Realm:    account.vendor.Region(),
		}
		var mods []core.TaskModule
		if s.modules != nil {
			mods = s.matchingAutoModules(account, moduleFilter)
			if len(mods) == 0 {
				entry.Skipped = "该渠道未挂载可自动执行的任务模块"
				out = append(out, entry)
				continue
			}
		} else {
			if _, okRunner := core.As[core.TaskRunner](account.vendor); !okRunner {
				entry.Skipped = "该供应商没有可自动执行的任务"
				out = append(out, entry)
				continue
			}
		}
		entry.Results, entry.Skipped = s.runLockedAutoModules(ctx, account, mods)
		out = append(out, entry)
		if index+1 < len(loaded) && !core.SleepContext(ctx, accountGap) {
			cancelled = true
			break
		}
	}
	done := 0
	for _, entry := range out {
		for _, result := range entry.Results {
			if result.Status == "done" {
				done++
			}
		}
	}
	payload := map[string]any{"ok": true, "accounts": len(out), "tasks_done": done, "results": out}
	if cancelled {
		// 关停/超时会把一轮砍在中途：如实标注「没跑完」，否则结果看起来像
		// 全部账号都执行过了。
		payload["cancelled"] = true
		payload["message"] = fmt.Sprintf("执行被中断：已完成 %d / %d 个账号", len(out), len(loaded))
	}
	return payload
}

func (s *Service) runLockedAutoModules(ctx context.Context, account *accountContext, mods []core.TaskModule) (results []autoAllResult, skipped string) {
	if errLock := s.lockAccount(ctx, account.uid()); errLock != nil {
		return nil, "等待该账号的其它任务超时：" + errLock.Error()
	}
	defer s.unlockAccount(account.uid())
	defer func() {
		if recovered := recover(); recovered != nil {
			results = []autoAllResult{{Status: core.AutoStatusError, Message: safe.NewPanicError("account task", recovered).Error()}}
		}
	}()
	if s.modules == nil {
		return s.runAutoAll(ctx, account), ""
	}
	return s.runAutoModules(ctx, account, mods), ""
}

func stringSet(values []string) map[string]bool {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]bool, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out[trimmed] = true
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ActivityStatus 返回指定活动的账号状态。
func (s *Service) ActivityStatus(ctx context.Context, callbackID, kind string) map[string]any {
	if _, active := s.catalog.SpecByKind(kind); !active {
		return map[string]any{"ok": true, "accounts": []any{}}
	}
	return map[string]any{"ok": true, "accounts": s.activityStatusForAccounts(ctx, callbackID, kind)}
}
