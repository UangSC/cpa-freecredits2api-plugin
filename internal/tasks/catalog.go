// Package tasks 提供供应商无关的任务目录、排程与调度基础设施。
package tasks

import (
	"sort"
	"strings"
	"time"

	"cpa-tierbridge2api-plugin/internal/core"
)

// Catalog 汇总已注册供应商与扩展模块的任务族。
type Catalog struct {
	registry      *core.Registry
	modules       *core.TaskRegistry
	enabledRealms func() []string
}

// NewCatalog 构造任务目录。
func NewCatalog(registry *core.Registry) *Catalog { return &Catalog{registry: registry} }

// SetModules 绑定可插拔任务模块注册表，使新扩展模块的排程与手动路由自动纳入目录。
func (c *Catalog) SetModules(modules *core.TaskRegistry) { c.modules = modules }

// Specs 汇总已启用任务族。共用任务族的模块合并默认整点与签到联动设置。
func (c *Catalog) Specs() []core.TaskSpec {
	out := make([]core.TaskSpec, 0, 8)
	indices := map[string]int{}
	add := func(spec core.TaskSpec) {
		kind := strings.TrimSpace(spec.Kind)
		if kind == "" {
			return
		}
		if index, exists := indices[kind]; exists {
			current := &out[index]
			current.DefaultHours = NormalizeHours(append(current.DefaultHours, spec.DefaultHours...))
			current.AfterCheckin = current.AfterCheckin || spec.AfterCheckin
			current.UsesChat = current.UsesChat || spec.UsesChat
			return
		}
		spec.Kind = kind
		spec.DefaultHours = NormalizeHours(spec.DefaultHours)
		indices[kind] = len(out)
		out = append(out, spec)
	}
	if c.anyCheckin() {
		add(core.TaskSpec{
			Kind:         core.TaskKindCheckin,
			Label:        "每日签到",
			Description:  "对所有支持签到的账号执行签到",
			DefaultHours: []int{9, 21},
			Manual:       true,
		})
	}
	for _, vendor := range c.registry.Vendors() {
		if !c.vendorEnabled(vendor.ID()) {
			continue
		}
		catalog, okCatalog := core.As[core.TaskCatalogProvider](vendor)
		if !okCatalog {
			continue
		}
		for _, spec := range catalog.TaskSpecs() {
			add(spec)
		}
	}
	for _, spec := range c.modules.TaskSpecsFor(c.vendorEnabled) {
		add(spec)
	}
	return out
}

func (c *Catalog) vendorEnabled(id string) bool {
	vendor, found := c.registry.ByID(id)
	return found && (c.enabledRealms == nil || core.RealmEnabled(c.enabledRealms(), vendor.Region()))
}

// SpecByKind 返回某个任务族的规格。
func (c *Catalog) SpecByKind(kind string) (core.TaskSpec, bool) {
	kind = strings.TrimSpace(kind)
	for _, spec := range c.Specs() {
		if spec.Kind == kind {
			return spec, true
		}
	}
	return core.TaskSpec{}, false
}

// ManualSpecs 返回需要管理端手动入口的任务族。
func (c *Catalog) ManualSpecs() []core.TaskSpec {
	all := c.Specs()
	out := make([]core.TaskSpec, 0, len(all))
	for _, spec := range all {
		if spec.Manual {
			out = append(out, spec)
		}
	}
	return out
}

// DefaultSchedule 从任务规格生成默认整点排程。
func (c *Catalog) DefaultSchedule() map[string][]int {
	out := map[string][]int{}
	for _, spec := range c.Specs() {
		if len(spec.DefaultHours) > 0 {
			out[spec.Kind] = append([]int(nil), spec.DefaultHours...)
		}
	}
	return out
}

// EffectiveSchedule 合并默认值、状态文件中的用户覆盖值与任务规格。
func (c *Catalog) EffectiveSchedule(overrides map[string][]int) map[string][]int {
	out := c.DefaultSchedule()
	for kind, hours := range overrides {
		kind = strings.TrimSpace(kind)
		if kind == "" {
			continue
		}
		if _, known := c.SpecByKind(kind); !known {
			continue
		}
		if len(hours) > 0 {
			out[kind] = NormalizeHours(hours)
		}
	}
	return out
}

// NormalizeHours 去重、排序并过滤非法小时。
func NormalizeHours(hours []int) []int {
	seen := map[int]bool{}
	out := make([]int, 0, len(hours))
	for _, hour := range hours {
		if hour < 0 || hour > 23 || seen[hour] {
			continue
		}
		seen[hour] = true
		out = append(out, hour)
	}
	sort.Ints(out)
	return out
}

// NextWake 返回下一次唤醒时刻与要执行的任务族。
func NextWake(now time.Time, schedule map[string][]int) ([]string, time.Time) {
	byHour := map[int][]string{}
	hours := make([]int, 0, len(schedule))
	for kind, list := range schedule {
		for _, hour := range NormalizeHours(list) {
			if _, okHour := byHour[hour]; !okHour {
				hours = append(hours, hour)
			}
			byHour[hour] = append(byHour[hour], kind)
		}
	}
	if len(hours) == 0 {
		return nil, now.Add(time.Hour)
	}
	sort.Ints(hours)
	for _, hour := range hours {
		candidate := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, now.Location())
		if candidate.After(now) {
			sort.Strings(byHour[hour])
			return byHour[hour], candidate
		}
	}
	first := hours[0]
	tomorrow := now.AddDate(0, 0, 1)
	sort.Strings(byHour[first])
	return byHour[first], time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), first, 0, 0, 0, now.Location())
}

func (c *Catalog) anyCheckin() bool {
	for _, vendor := range c.registry.Vendors() {
		if c.vendorEnabled(vendor.ID()) && core.SupportsCheckin(vendor) {
			return true
		}
	}
	return false
}
