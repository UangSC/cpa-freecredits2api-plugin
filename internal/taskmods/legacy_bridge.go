package taskmods

// 本文件为尚未抽离成独立文件的既有供应商活动任务提供统一桥接适配器，
// 使所有存量任务渠道无缝纳入 core.TaskRegistry 协议管理，同时精准排除无任务渠道。

import (
	"context"
	"fmt"
	"strings"

	"cpa-tierbridge2api-plugin/internal/core"
)

// legacyProfile 描述一个待桥接的既有任务渠道的展示与能力元信息。
//
// 明确只列出「确实存在独立活动/成长任务体系」的渠道：
//   - 无任务渠道（cline / opencodezen / qwenwork / tokenplan）不进入列表；
//   - 仅含每日签到、无额外活动体系的渠道（qoder / minimaxcode / raccoon / workbuddyglobal / traeglobal）
//     统一归由账号页「一键签到」与每日自动签到负责，不再混入「一键做任务」。
type legacyProfile struct {
	moduleID     string
	kind         string
	category     string
	name         string
	description  string
	usesChat     bool
	supportsScan bool
	priority     int
}

var legacyVendorProfiles = map[string]legacyProfile{
	"workbuddycn": {
		moduleID:     "workbuddy.tasks",
		kind:         "growth",
		category:     core.TaskCategoryActivity,
		name:         "成长任务与活动闭环",
		description:  "涵盖成长任务、猫猫旅行、活跃上报、夜猫子与连登奖励；专家、技能和夜猫子可消耗对话额度",
		usesChat:     true,
		supportsScan: true,
		priority:     10,
	},
	"autoclawcn": {
		moduleID:    "autoclaw.cn_login_active",
		kind:        "login_active",
		category:    core.TaskCategoryDaily,
		name:        "每日登录活跃奖励",
		description: "执行 AutoClaw 国内版签到并补报每日登录活跃，奖励由渠道发放",
		priority:    30,
	},
	"autoclawglobal": {
		moduleID:    "autoclaw.global_login_active",
		kind:        "login_active",
		category:    core.TaskCategoryDaily,
		name:        "每日登录活跃奖励",
		description: "执行 AutoClaw 国际版签到并补报每日登录活跃，奖励由渠道发放",
		priority:    30,
	},
	"zcodecn": {
		moduleID:    "zcode.cn_activity",
		kind:        "activity",
		category:    core.TaskCategoryBenefit,
		name:        "活动资格检查",
		description: "执行 ZCode 国内版活跃上报与活动资格检查，套餐需在账号页完成验证后领取",
		priority:    30,
	},
	"zcodeglobal": {
		moduleID:    "zcode.global_activity",
		kind:        "activity",
		category:    core.TaskCategoryBenefit,
		name:        "活动资格检查",
		description: "执行 ZCode 国际版活跃上报与活动资格检查，套餐需在账号页完成验证后领取",
		priority:    30,
	},
}

// LegacyModulesFor 为注册表中尚未单独抽离的任务渠道生成桥接 TaskModule。
//
// 独立模块如替代存量桥接，沿用其模块 ID。同一渠道的其它模块可并行注册。
func LegacyModulesFor(registry *core.Registry, coveredModules map[string]bool) []core.TaskModule {
	if registry == nil {
		return nil
	}
	out := make([]core.TaskModule, 0, len(legacyVendorProfiles))
	for _, vendor := range registry.Vendors() {
		id := vendor.ID()
		profile, ok := legacyVendorProfiles[id]
		if !ok || coveredModules[profile.moduleID] {
			continue
		}
		if _, hasRunner := core.As[core.TaskRunner](vendor); !hasRunner {
			continue
		}
		base := legacyTaskModule{
			vendorID: id,
			profile:  profile,
		}
		if _, hasInspector := core.As[core.TaskInspector](vendor); hasInspector {
			out = append(out, legacyScannableModule{legacyTaskModule: base})
		} else {
			out = append(out, base)
		}
	}
	return out
}

type legacyTaskModule struct {
	vendorID string
	profile  legacyProfile
}

func (m legacyTaskModule) Meta() core.TaskModuleMeta {
	return core.TaskModuleMeta{
		ID:           m.profile.moduleID,
		VendorIDs:    []string{m.vendorID},
		Kind:         m.profile.kind,
		Category:     m.profile.category,
		Name:         m.profile.name,
		Description:  m.profile.description,
		UsesChat:     m.profile.usesChat,
		SupportsScan: m.profile.supportsScan,
		AutoEligible: true,
		Priority:     m.profile.priority,
	}
}

func (m legacyTaskModule) Applicable(target core.TaskModuleTarget) (bool, string) {
	if target.Vendor == nil || target.Vendor.ID() != m.vendorID {
		return false, "不适用于当前渠道"
	}
	if target.Cred == nil {
		return false, "账号凭证为空"
	}
	return true, ""
}

func (m legacyTaskModule) Prepare(ctx context.Context, target core.TaskModuleTarget) int {
	if preparer, ok := core.As[core.TaskPreparer](target.Vendor); ok {
		return preparer.PrepareTasks(ctx, target.Cred)
	}
	return 0
}

func (m legacyTaskModule) Run(ctx context.Context, target core.TaskModuleTarget, code string) ([]core.AutoTaskResult, error) {
	runner, ok := core.As[core.TaskRunner](target.Vendor)
	if !ok {
		return nil, fmt.Errorf("渠道 %s 未实现任务执行器", m.vendorID)
	}
	trimmed := strings.TrimSpace(code)
	if trimmed == "" {
		return runner.RunAllTasks(ctx, target.Cred), nil
	}
	res, err := runner.RunTask(ctx, target.Cred, trimmed)
	if err != nil {
		return nil, err
	}
	return []core.AutoTaskResult{{
		Code:    trimmed,
		Status:  core.FirstNonEmpty(res.Status, core.AutoStatusDone),
		Message: res.Message,
		Credit:  res.Credit,
		Energy:  res.Energy,
	}}, nil
}

type legacyScannableModule struct {
	legacyTaskModule
}

func (m legacyScannableModule) Inspect(ctx context.Context, target core.TaskModuleTarget) (core.TaskInspection, error) {
	inspector, ok := core.As[core.TaskInspector](target.Vendor)
	if !ok {
		return core.TaskInspection{}, nil
	}
	inspection, err := inspector.InspectTasks(ctx, target.Cred)
	if err != nil {
		return core.TaskInspection{}, err
	}
	for i := range inspection.Items {
		inspection.Items[i].ModuleID = m.profile.moduleID
		if inspection.Items[i].KindLabel == "" {
			inspection.Items[i].KindLabel = defaultKindLabel(inspection.Items[i].Kind)
		}
	}
	return inspection, nil
}

func defaultKindLabel(kind string) string {
	switch strings.TrimSpace(kind) {
	case "school":
		return "开学季活动"
	case "growth":
		return "成长任务"
	default:
		return strings.TrimSpace(kind)
	}
}

var (
	_ core.TaskModule           = legacyTaskModule{}
	_ core.PreparableTaskModule = legacyTaskModule{}
	_ core.ScannableTaskModule  = legacyScannableModule{}
)
