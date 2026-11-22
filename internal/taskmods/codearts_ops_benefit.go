package taskmods

// 本文件是标准「任务/活动扩展模块」样板 #2：CodeArts 运营活动福利。
//
// 展示如何复用供应商的签名/凭证辅助函数，把「限时运营活动」完全抽离出供应商主适配器，
// 同时赋予该渠道原本没有的「任务中心实时扫描（ScannableTaskModule）」能力。

import (
	"context"
	"strings"

	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/vendors/codearts"
)

// ModuleIDCodeArtsOpsBenefit 是 CodeArts 运营活动福利模块的全局唯一标识。
const ModuleIDCodeArtsOpsBenefit = "codearts.ops_benefit"

// TaskKindCodeArtsOpsBenefit 是该模块对应的任务族标识。
const TaskKindCodeArtsOpsBenefit = "ops_benefit"

type codeArtsOpsBenefitModule struct{}

// NewCodeArtsOpsBenefit 构造 CodeArts 运营活动福利扩展模块。
func NewCodeArtsOpsBenefit() core.TaskModule { return codeArtsOpsBenefitModule{} }

func (codeArtsOpsBenefitModule) Meta() core.TaskModuleMeta {
	return core.TaskModuleMeta{
		ID:           ModuleIDCodeArtsOpsBenefit,
		VendorIDs:    []string{codearts.VendorID},
		Kind:         TaskKindCodeArtsOpsBenefit,
		Category:     core.TaskCategoryBenefit,
		Name:         "华为云运营活动福利",
		Description:  "扫描并领取 CodeArts 运营活动列表里除每日登录外的可领积分福利（不消耗对话额度）",
		UsesChat:     false,
		SupportsScan: true,
		AutoEligible: true,
		Priority:     20,
	}
}

func (codeArtsOpsBenefitModule) Applicable(target core.TaskModuleTarget) (bool, string) {
	if target.Vendor == nil || target.Vendor.ID() != codearts.VendorID {
		return false, "仅 CodeArts 渠道支持华为云运营活动"
	}
	return codearts.HasOpsCredential(target.Cred)
}

func (codeArtsOpsBenefitModule) Inspect(ctx context.Context, target core.TaskModuleTarget) (core.TaskInspection, error) {
	inspection, err := codearts.InspectOpsActivities(ctx, target.Cred)
	if err != nil {
		return core.TaskInspection{}, err
	}
	for i := range inspection.Items {
		inspection.Items[i].ModuleID = ModuleIDCodeArtsOpsBenefit
		if inspection.Items[i].KindLabel == "" {
			inspection.Items[i].KindLabel = "运营活动"
		}
	}
	return inspection, nil
}

func (codeArtsOpsBenefitModule) Run(ctx context.Context, target core.TaskModuleTarget, code string) ([]core.AutoTaskResult, error) {
	trimmed := strings.TrimSpace(code)
	campaignID := ""
	if trimmed != "" && trimmed != codearts.AutoTaskCodeOpsBenefit {
		if id, ok := strings.CutPrefix(trimmed, "ops:"); ok {
			campaignID = strings.TrimSpace(id)
		}
		if campaignID != "" {
			return []core.AutoTaskResult{codearts.RunOpsActivities(ctx, target.Cred, campaignID)}, nil
		}
		return []core.AutoTaskResult{{
			Code:    trimmed,
			Status:  core.AutoStatusSkipped,
			Message: "该任务码不属于 CodeArts 运营活动模块",
		}}, nil
	}
	return []core.AutoTaskResult{codearts.RunOpsActivities(ctx, target.Cred, "")}, nil
}

var (
	_ core.TaskModule          = codeArtsOpsBenefitModule{}
	_ core.ScannableTaskModule = codeArtsOpsBenefitModule{}
)
