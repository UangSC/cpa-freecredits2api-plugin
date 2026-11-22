package tasks

// 本文件是任务引擎的实例入口：调度循环、队列状态与账号锁。

import (
	"context"
	"sync"
	"time"

	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/logger"
	"cpa-freecredits2api-plugin/internal/safe"
)

// Service 是一个 App 实例的任务引擎。
type Service struct {
	deps    Deps
	catalog *Catalog
	modules *core.TaskRegistry

	schedulerMu     sync.Mutex
	schedulerCancel context.CancelFunc
	schedulerWG     sync.WaitGroup
	running         bool
	pokeCh          chan string

	taskLockMu sync.Mutex
	taskLocks  map[string]chan struct{}
	queue      *queueState
	// autoAll 是「一键完成」的后台任务状态（见 autoall.go）。
	autoAll *autoAllJob

	// refreshGate 按账号串行化凭证续期（见 keepalive.go）。
	refreshGate refreshGate

	// jobMu/jobCtx/jobCancel 是后台动作（一键完成、异步任务族）的生命周期：
	// 插件关停时会 dlclose 动态库，若还有后台 goroutine 在打宿主回调就会崩。
	// Stop 先取消它，再给 jobWG 一个宽限期等 goroutine 自己退出。
	jobMu     sync.Mutex
	jobCtx    context.Context
	jobCancel context.CancelFunc
	jobWG     sync.WaitGroup
}

// jobStopGrace 是关停时等待后台动作收尾的宽限期。
const jobStopGrace = 5 * time.Second

// trackJob 在后台跑一个动作并登记到 jobWG，Stop 会等它结束。
//
// Add 必须与 Stop 的 Wait 互斥：两者都在 jobMu 下判断 jobCtx，Stop 先把
// jobCtx 置空再 Wait，因此不会出现「Wait 已开始又 Add」这种 WaitGroup 的
// 未定义用法。调度未启动时仍执行，但不登记（没有东西会等它）。
func (s *Service) trackJob(run func(ctx context.Context)) {
	s.jobMu.Lock()
	ctx, tracked := s.jobCtx, s.jobCtx != nil
	if tracked {
		s.jobWG.Add(1)
	}
	s.jobMu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		if tracked {
			defer s.jobWG.Done()
		}
		defer safe.Recover("task job")
		run(ctx)
	}()
}

// New 构造任务引擎。
func New(deps Deps) *Service {
	catalog := NewCatalog(deps.Registry())
	catalog.enabledRealms = func() []string { return deps.Config().EnabledRealms }
	return &Service{
		deps:      deps,
		catalog:   catalog,
		pokeCh:    make(chan string, 4),
		taskLocks: map[string]chan struct{}{},
		queue:     &queueState{},
		autoAll:   &autoAllJob{},
	}
}

// Catalog 返回任务目录。
func (s *Service) Catalog() *Catalog { return s.catalog }

// SetModules 挂载可插拔任务扩展注册表，并同步到任务目录。
func (s *Service) SetModules(reg *core.TaskRegistry) {
	s.modules = reg
	if s.catalog != nil {
		s.catalog.SetModules(reg)
	}
}

// Modules 返回当前挂载的任务扩展注册表（未挂载时为 nil）。
func (s *Service) Modules() *core.TaskRegistry { return s.modules }

// ModuleMetas 返回全部已挂载任务扩展模块的元数据快照。
func (s *Service) ModuleMetas() []core.TaskModuleMeta {
	metas := make([]core.TaskModuleMeta, 0)
	for _, meta := range s.modules.Metas() {
		ids := meta.VendorIDs[:0]
		for _, vendorID := range meta.VendorIDs {
			if s.catalog.vendorEnabled(vendorID) {
				ids = append(ids, vendorID)
			}
		}
		if len(ids) > 0 {
			meta.VendorIDs = ids
			metas = append(metas, meta)
		}
	}
	return metas
}

// Start 启动后台调度循环（幂等）。
func (s *Service) Start(ctx context.Context) {
	s.schedulerMu.Lock()
	defer s.schedulerMu.Unlock()
	if s.schedulerCancel != nil {
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.schedulerCancel = cancel
	s.jobMu.Lock()
	jobCtx, jobCancel := context.WithCancel(context.Background())
	s.jobCtx, s.jobCancel = jobCtx, jobCancel
	s.jobMu.Unlock()
	s.schedulerWG.Add(1)
	go func() {
		defer s.schedulerWG.Done()
		defer safe.Recover("task scheduler")
		s.runTaskScheduler(runCtx)
	}()
}

// Stop 停止后台调度循环与后台动作并等待退出。
func (s *Service) Stop() {
	s.schedulerMu.Lock()
	cancel := s.schedulerCancel
	s.schedulerCancel = nil
	s.schedulerMu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.jobMu.Lock()
	jobCancel := s.jobCancel
	s.jobCtx, s.jobCancel = nil, nil
	s.jobMu.Unlock()
	if jobCancel != nil {
		jobCancel()
	}
	s.schedulerWG.Wait()
	// 后台动作可能正卡在上游 HTTP 上，取消不会立刻生效：给一个宽限期，
	// 超时就放手（宿主进程即将卸载插件，继续等只会拖慢关停）。
	done := make(chan struct{})
	go func() {
		s.jobWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(jobStopGrace):
	}
}

// Poke 唤醒调度循环重新计算下次执行时刻。
func (s *Service) Poke() {
	select {
	case s.pokeCh <- schedulerReconfigure:
	default:
	}
}

// Status 返回调度器状态（供管理页展示）。
func (s *Service) Status() map[string]any { return s.schedulerStatus() }

// EffectiveSettings 返回页面设置与配置合并后的可读视图。
func (s *Service) EffectiveSettings() map[string]any { return s.effectiveSettings() }

// ManualRoute 是已注册任务的管理端触发入口。
type ManualRoute struct {
	Path        string
	Description string
	Kind        string
	ModuleID    string
}

// ManualRoutes 返回各模块和存量任务族的触发入口。
func (s *Service) ManualRoutes() []ManualRoute {
	var routes []ManualRoute
	seen := map[string]bool{}
	for _, meta := range s.ModuleMetas() {
		if meta.Manual && meta.Route != "" && !seen[meta.Route] {
			routes = append(routes, ManualRoute{Path: meta.Route, Description: meta.Description, Kind: meta.Kind, ModuleID: meta.ID})
			seen[meta.Route] = true
		}
	}
	for _, spec := range s.catalog.ManualSpecs() {
		if spec.Route != "" && !seen[spec.Route] {
			routes = append(routes, ManualRoute{Path: spec.Route, Description: spec.Description, Kind: spec.Kind})
			seen[spec.Route] = true
		}
	}
	return routes
}

// RunManual 在后台执行指定任务模块或存量任务族。
func (s *Service) RunManual(route ManualRoute) {
	s.trackJob(func(ctx context.Context) {
		if route.ModuleID == "" {
			s.runScheduledTaskContext(ctx, route.Kind)
			return
		}
		mod, found := s.modules.ByID(route.ModuleID)
		if !found {
			return
		}
		meta := mod.Meta()
		s.forEachAccount(ctx, "", nil, func(ctx context.Context, account *accountContext) error {
			if !meta.SupportsVendor(account.vendor.ID()) {
				return nil
			}
			target := core.TaskModuleTarget{Vendor: account.vendor, Cred: account.credential}
			if applicable, _ := mod.Applicable(target); !applicable {
				return nil
			}
			results, skipped := s.runLockedAutoModules(ctx, account, []core.TaskModule{mod})
			if skipped != "" {
				logger.Info("%s %s: %s", meta.ID, account.label(), skipped)
			}
			for _, result := range results {
				if result.Status == core.AutoStatusError {
					logger.Error("%s %s: %s", meta.ID, account.label(), result.Message)
				} else {
					logger.Info("%s %s: %s", meta.ID, account.label(), result.Message)
				}
			}
			return nil
		})
	})
}
