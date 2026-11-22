package taskmods

// 本文件是标准「任务/活动扩展模块」样板 #1：Trae 国内版活动福利（UG）。
//
// 新增任意渠道的限时活动只需参照此结构：
//  1. 在 internal/taskmods/ 新建独立文件实现 core.TaskModule（按需实现 Scannable/Scheduled）；
//  2. 在 internal/app/taskmods.go 注册 1 行；
//  3. 无需修改任务引擎、管理路由、前端控制台或供应商核心对话/额度代码。

import (
	"context"
	"strings"

	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/vendors/trae"
)

// ModuleIDTraeUG 是 Trae 国内版活动福利模块的全局唯一标识。
const ModuleIDTraeUG = "trae.ug"

type traeUGModule struct{}

// NewTraeUG 构造 Trae 国内版活动福利扩展模块。
func NewTraeUG() core.TaskModule { return traeUGModule{} }

func (traeUGModule) Meta() core.TaskModuleMeta {
	return core.TaskModuleMeta{
		ID:           ModuleIDTraeUG,
		VendorIDs:    []string{trae.VendorIDCN},
		Kind:         trae.TaskKindUG,
		Category:     core.TaskCategoryBenefit,
		Name:         "Trae 活动福利领取",
		Description:  "扫描并领取 Trae 国内版活动中心与分享裂变积分（幂等，不消耗对话额度）",
		UsesChat:     false,
		SupportsScan: true,
		AutoEligible: true,
		Manual:       true,
		Route:        "/ug/claim",
		Priority:     20,
	}
}

func (traeUGModule) Applicable(target core.TaskModuleTarget) (bool, string) {
	if target.Vendor == nil || target.Vendor.ID() != trae.VendorIDCN {
		return false, "仅 Trae 国内版支持活动福利"
	}
	if target.Cred == nil {
		return false, "账号凭证为空"
	}
	return true, ""
}

func (traeUGModule) Inspect(ctx context.Context, target core.TaskModuleTarget) (core.TaskInspection, error) {
	inspector, ok := core.As[core.TaskInspector](target.Vendor)
	if !ok {
		return core.TaskInspection{}, nil
	}
	inspection, err := inspector.InspectTasks(ctx, target.Cred)
	if err != nil {
		return core.TaskInspection{}, err
	}
	for i := range inspection.Items {
		inspection.Items[i].ModuleID = ModuleIDTraeUG
		if inspection.Items[i].KindLabel == "" {
			inspection.Items[i].KindLabel = "活动福利"
		}
	}
	return inspection, nil
}

func (traeUGModule) Run(ctx context.Context, target core.TaskModuleTarget, code string) ([]core.AutoTaskResult, error) {
	runner, ok := core.As[core.TaskRunner](target.Vendor)
	if !ok {
		return []core.AutoTaskResult{{
			Code:    trae.AutoTaskCodeUG,
			Status:  core.AutoStatusSkipped,
			Message: "该渠道未提供活动福利执行器",
		}}, nil
	}
	targetCode := strings.TrimSpace(code)
	if targetCode == "" {
		targetCode = trae.AutoTaskCodeUG
	}
	res, err := runner.RunTask(ctx, target.Cred, targetCode)
	if err != nil {
		return nil, err
	}
	return []core.AutoTaskResult{{
		Code:    targetCode,
		Status:  core.FirstNonEmpty(res.Status, core.AutoStatusDone),
		Message: res.Message,
		Credit:  res.Credit,
		Energy:  res.Energy,
	}}, nil
}

func (traeUGModule) RunScheduled(ctx context.Context, target core.TaskModuleTarget) (string, error) {
	runner, ok := core.As[core.ScheduledRunner](target.Vendor)
	if !ok {
		return "", nil
	}
	return runner.RunScheduled(ctx, target.Cred, trae.TaskKindUG)
}

var (
	_ core.TaskModule          = traeUGModule{}
	_ core.ScannableTaskModule = traeUGModule{}
	_ core.ScheduledTaskModule = traeUGModule{}
)
