package app

import (
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/taskmods"
)

// BuiltinTaskModules 返回按当前已注册供应商装配好的全部任务/活动扩展模块。
//
// 新增任意渠道的活动/任务模块只需两步：
//  1. 在 internal/taskmods/ 新建独立文件实现 core.TaskModule；
//  2. 在下方 explicit 列表追加 1 行（如 taskmods.NewXxx()）；
//
// 其余模块注册、管理接口（/tasks/modules、/vendors、/status）、
// 任务扫描、队列执行、一键做任务与定时排程均自动接管，无需改动引擎或前端。
func BuiltinTaskModules(registry *core.Registry) []core.TaskModule {
	explicit := []core.TaskModule{
		taskmods.NewTraeUG(),
		taskmods.NewCodeArtsOpsBenefit(),
	}
	out := make([]core.TaskModule, 0, len(explicit)+8)
	coveredModules := make(map[string]bool, len(explicit))
	for _, mod := range explicit {
		if mod == nil {
			continue
		}
		meta := mod.Meta()
		if !hasRegisteredVendor(registry, meta.VendorIDs) {
			continue
		}
		out = append(out, mod)
		coveredModules[meta.ID] = true
	}
	out = append(out, taskmods.LegacyModulesFor(registry, coveredModules)...)
	return out
}

func hasRegisteredVendor(registry *core.Registry, vendorIDs []string) bool {
	if registry == nil {
		return false
	}
	for _, vendorID := range vendorIDs {
		if _, ok := registry.ByID(vendorID); ok {
			return true
		}
	}
	return false
}
