package core

// 本文件定义可插拔的「任务/活动扩展协议（TaskModule）」与统一注册表（TaskRegistry）。
//
// 设计原则：
//   - 渠道无关、插件化接入：每个活动/任务模块独立声明适用渠道（VendorIDs）、
//     类别、是否消耗真实对话额度、是否支持扫描与默认排程；
//   - 能力精确隔离：未注册任务模块的渠道天然不暴露任务入口，按账号调用
//     Applicable 二次判定（如跳过企业号/国际版）；
//   - 平滑兼容存量：旧的 TaskRunner / TaskInspector 供应商可通过桥接模块接入
//     同一注册表，新活动直接写独立模块注册即可，无需改引擎、管理路由或前端。

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// 通用任务模块分类标识（用于前端分组与筛选标签展示）。
const (
	TaskCategoryDaily    = "daily"
	TaskCategoryActivity = "activity"
	TaskCategoryBenefit  = "benefit"
	TaskCategoryCampaign = "campaign"
)

// TaskModuleMeta 是单个任务/活动扩展模块的自描述元数据。
//
// 后端调度、管理接口（GET /tasks/modules、/vendors、/status）与控制台任务页
// 统一按此结构驱动，新增模块只需声明元数据即可自动上屏，无需改前端或路由。
type TaskModuleMeta struct {
	// ID 是全局唯一模块标识，推荐 "<vendor>.<activity>"（如 "trae.ug"）。
	ID string `json:"id"`
	// VendorIDs 声明该模块适用的供应商实例 ID 列表（如 ["traecn"]）。
	VendorIDs []string `json:"vendor_ids"`
	// Kind 是任务族/分类标识（用于排程与队列过滤，如 "ug"、"ops_benefit"）。
	Kind string `json:"kind"`
	// Category 是通用类别（daily / activity / benefit / campaign）。
	Category string `json:"category,omitempty"`
	// Name 是展示给用户的模块名称。
	Name string `json:"name"`
	// Description 是模块功能与注意事项说明。
	Description string `json:"description,omitempty"`
	// UsesChat 报告该模块是否会发起真实模型对话并消耗账号额度。
	UsesChat bool `json:"uses_chat,omitempty"`
	// SupportsScan 报告该模块是否实现了 ScannableTaskModule（支持前置扫描待办）。
	SupportsScan bool `json:"supports_scan,omitempty"`
	// AutoEligible 报告该模块是否参与「一键做任务」。
	AutoEligible bool `json:"auto_eligible,omitempty"`
	// DefaultHours 是定时排程的默认整点小时（0-23）；为空表示默认不定时自动跑。
	DefaultHours []int `json:"default_hours,omitempty"`
	// AfterCheckin 为 true 时在每日自动签到后联动执行。
	AfterCheckin bool `json:"after_checkin,omitempty"`
	// Manual 为 true 且 Route 非空时自动注册此模块的管理端手动触发路由。
	Manual bool `json:"manual,omitempty"`
	// Route 是可选手动触发子路由（如 "/ug/claim"）。
	Route string `json:"route,omitempty"`
	// Priority 决定同一渠道内多个模块的执行先后，越小越先执行。
	Priority int `json:"priority,omitempty"`
}

// SupportsVendor 报告元数据是否声明支持指定供应商 ID。
func (m TaskModuleMeta) SupportsVendor(vendorID string) bool {
	vendorID = strings.TrimSpace(vendorID)
	if vendorID == "" {
		return false
	}
	for _, id := range m.VendorIDs {
		if strings.TrimSpace(id) == vendorID {
			return true
		}
	}
	return false
}

// TaskModuleTarget 是一次模块判定或执行的目标上下文。
type TaskModuleTarget struct {
	Vendor Vendor
	Cred   *Credential
}

// TaskModule 是所有可插拔任务/活动模块必须实现的最小协议。
type TaskModule interface {
	// Meta 返回模块自描述元数据（必须并发安全且稳定）。
	Meta() TaskModuleMeta
	// Applicable 判断目标账号是否适用本模块；不适用时返回 false 与可读原因。
	Applicable(target TaskModuleTarget) (bool, string)
	// Run 执行本模块任务：code 为空时执行本模块全部动作，非空时执行指定子任务码。
	Run(ctx context.Context, target TaskModuleTarget, code string) ([]AutoTaskResult, error)
}

// ScannableTaskModule 由支持前置扫描待办条目的任务模块实现。
type ScannableTaskModule interface {
	Inspect(ctx context.Context, target TaskModuleTarget) (TaskInspection, error)
}

// PreparableTaskModule 由需要在队列执行前批量报名/准备的任务模块实现。
type PreparableTaskModule interface {
	Prepare(ctx context.Context, target TaskModuleTarget) int
}

// ScheduledTaskModule 由支持按排程任务族直接执行的任务模块实现。
type ScheduledTaskModule interface {
	RunScheduled(ctx context.Context, target TaskModuleTarget) (string, error)
}

// TaskRegistry 是任务扩展模块的统一注册表（并发安全）。
type TaskRegistry struct {
	mu      sync.RWMutex
	modules []TaskModule
	byID    map[string]TaskModule
}

// NewTaskRegistry 构造空任务模块注册表。
func NewTaskRegistry() *TaskRegistry {
	return &TaskRegistry{
		byID: map[string]TaskModule{},
	}
}

// Register 注册一个任务扩展模块。
func (r *TaskRegistry) Register(mod TaskModule) error {
	if r == nil {
		return fmt.Errorf("task registry is nil")
	}
	if mod == nil {
		return fmt.Errorf("task module is nil")
	}
	meta := mod.Meta()
	id := strings.TrimSpace(meta.ID)
	if id == "" {
		return fmt.Errorf("task module id is empty")
	}
	if len(meta.VendorIDs) == 0 {
		return fmt.Errorf("task module %q must declare at least one vendor_id", id)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.byID[id]; exists {
		return fmt.Errorf("duplicate task module %q", id)
	}
	r.byID[id] = mod
	r.modules = append(r.modules, mod)
	return nil
}

// Modules 返回全部已注册模块（按 Priority 升序、保持注册先后）。
func (r *TaskRegistry) Modules() []TaskModule {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	out := make([]TaskModule, len(r.modules))
	copy(out, r.modules)
	r.mu.RUnlock()
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Meta().Priority < out[j].Meta().Priority
	})
	return out
}

// Metas 返回全部已注册模块的元数据副本（SupportsScan 自动按接口能力补齐）。
func (r *TaskRegistry) Metas() []TaskModuleMeta {
	mods := r.Modules()
	out := make([]TaskModuleMeta, 0, len(mods))
	for _, mod := range mods {
		out = append(out, normalizedModuleMeta(mod))
	}
	return out
}

// ByID 按模块 ID 查找已注册模块。
func (r *TaskRegistry) ByID(id string) (TaskModule, bool) {
	if r == nil {
		return nil, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	mod, ok := r.byID[strings.TrimSpace(id)]
	return mod, ok
}

// ForVendor 返回声明支持指定供应商的全部模块（按 Priority 升序）。
func (r *TaskRegistry) ForVendor(vendorID string) []TaskModule {
	vendorID = strings.TrimSpace(vendorID)
	if r == nil || vendorID == "" {
		return nil
	}
	mods := r.Modules()
	out := make([]TaskModule, 0, 2)
	for _, mod := range mods {
		if mod.Meta().SupportsVendor(vendorID) {
			out = append(out, mod)
		}
	}
	return out
}

// MetasForVendor 返回指定供应商的全部模块元数据。
func (r *TaskRegistry) MetasForVendor(vendorID string) []TaskModuleMeta {
	mods := r.ForVendor(vendorID)
	if len(mods) == 0 {
		return nil
	}
	out := make([]TaskModuleMeta, 0, len(mods))
	for _, mod := range mods {
		out = append(out, normalizedModuleMeta(mod))
	}
	return out
}

// ForVendorKind 返回指定供应商与任务族 kind 匹配的模块。
func (r *TaskRegistry) ForVendorKind(vendorID, kind string) []TaskModule {
	kind = strings.TrimSpace(kind)
	if kind == "" {
		return nil
	}
	mods := r.ForVendor(vendorID)
	out := make([]TaskModule, 0, 2)
	for _, mod := range mods {
		if strings.TrimSpace(mod.Meta().Kind) == kind {
			out = append(out, mod)
		}
	}
	return out
}

// ApplicableModules 返回对目标账号实际适用的任务模块列表。
func (r *TaskRegistry) ApplicableModules(vendor Vendor, cred *Credential) []TaskModule {
	if r == nil || vendor == nil {
		return nil
	}
	mods := r.ForVendor(vendor.ID())
	if len(mods) == 0 {
		return nil
	}
	target := TaskModuleTarget{Vendor: vendor, Cred: cred}
	out := make([]TaskModule, 0, len(mods))
	for _, mod := range mods {
		if ok, _ := mod.Applicable(target); ok {
			out = append(out, mod)
		}
	}
	return out
}

// VendorHasTasks 报告该供应商是否挂载了任意任务模块。
func (r *TaskRegistry) VendorHasTasks(vendorID string) bool {
	return len(r.ForVendor(vendorID)) > 0
}

// VendorSupportsScan 报告该供应商是否挂载了支持扫描待办的任务模块。
func (r *TaskRegistry) VendorSupportsScan(vendorID string) bool {
	for _, mod := range r.ForVendor(vendorID) {
		if _, ok := mod.(ScannableTaskModule); ok {
			return true
		}
	}
	return false
}

// VendorSupportsAuto 报告该供应商是否挂载了参与一键任务的模块。
func (r *TaskRegistry) VendorSupportsAuto(vendorID string) bool {
	for _, mod := range r.ForVendor(vendorID) {
		if mod.Meta().AutoEligible {
			return true
		}
	}
	return false
}

// AccountHasAutoTasks 报告指定账号是否至少有一个适用的一键任务模块。
func (r *TaskRegistry) AccountHasAutoTasks(vendor Vendor, cred *Credential) bool {
	for _, mod := range r.ApplicableModules(vendor, cred) {
		if mod.Meta().AutoEligible {
			return true
		}
	}
	return false
}

// AccountModuleIDs 返回对指定账号适用的全部模块 ID 列表。
func (r *TaskRegistry) AccountModuleIDs(vendor Vendor, cred *Credential) []string {
	mods := r.ApplicableModules(vendor, cred)
	if len(mods) == 0 {
		return nil
	}
	out := make([]string, 0, len(mods))
	for _, mod := range mods {
		out = append(out, mod.Meta().ID)
	}
	return out
}

// TaskSpecs 把实现定时执行接口的模块投影为通用 TaskSpec。
func (r *TaskRegistry) TaskSpecs() []TaskSpec {
	return r.TaskSpecsFor(nil)
}

// TaskSpecsFor 可按渠道过滤任务排程规格。
func (r *TaskRegistry) TaskSpecsFor(allowedVendor func(string) bool) []TaskSpec {
	mods := r.Modules()
	out := make([]TaskSpec, 0, len(mods))
	for _, mod := range mods {
		if _, scheduled := mod.(ScheduledTaskModule); !scheduled {
			continue
		}
		meta := mod.Meta()
		kind := strings.TrimSpace(meta.Kind)
		if kind == "" {
			continue
		}
		if allowedVendor != nil {
			allowed := false
			for _, vendorID := range meta.VendorIDs {
				allowed = allowed || allowedVendor(vendorID)
			}
			if !allowed {
				continue
			}
		}
		out = append(out, TaskSpec{
			Kind:         kind,
			Label:        FirstNonEmpty(meta.Name, kind),
			Description:  meta.Description,
			DefaultHours: append([]int(nil), meta.DefaultHours...),
			AfterCheckin: meta.AfterCheckin,
			Manual:       meta.Manual,
			UsesChat:     meta.UsesChat,
			Route:        meta.Route,
		})
	}
	return out
}

func normalizedModuleMeta(mod TaskModule) TaskModuleMeta {
	meta := mod.Meta()
	_, meta.SupportsScan = mod.(ScannableTaskModule)
	if len(meta.VendorIDs) > 0 {
		meta.VendorIDs = append([]string(nil), meta.VendorIDs...)
	}
	if len(meta.DefaultHours) > 0 {
		meta.DefaultHours = append([]int(nil), meta.DefaultHours...)
	}
	return meta
}
