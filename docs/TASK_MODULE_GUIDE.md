# 可插拔任务 / 活动模块开发指南（TaskModule Protocol）

本项目将各渠道的**活动任务、限时福利、成长闭环**抽离为标准化的插件口协议（`core.TaskModule`），与主账号管理、模型对话、额度查询、每日签到和控制台 UI 彻底解耦。

> **核心收益**
> - **无任务渠道零侵入**：未挂载任务模块的渠道（如 Cline、OpenCode ZEN、千问办公、书生 Token Plan 等）不会在前端出现任何任务入口，也不会被「一键做任务」误触发。
> - **新增活动仅改 2 处**：开发者或 AI 只需在 `internal/taskmods/` 新建 1 个独立文件 + 在 `internal/app/taskmods.go` 注册 1 行，**无需改动**任务引擎（`internal/tasks/`）、管理路由（`internal/admin/`）、前端控制台（`internal/admin/ui/`）或供应商核心推理代码。
> - **静态守卫兜底**：`tests/architecture_test.go` 强制禁止 `internal/tasks` 和 `internal/admin` 依赖 `internal/taskmods`，防止后续演进重新耦合。

---

## 1. 协议定义（`internal/core/task_module.go`）

每个活动模块只需实现最小核心接口 `core.TaskModule`，并按需实现 3 个可选扩展接口：

| 接口 | 必选/可选 | 作用 |
| --- | --- | --- |
| `core.TaskModule` | **必选** | 声明元数据 `Meta()`、账号级适用判定 `Applicable(target)`、执行入口 `Run(ctx, target, code)` |
| `core.ScannableTaskModule` | 可选 | 实现 `Inspect(ctx, target)`，使该模块自动接入任务中心的「扫描待办」与队列执行 |
| `core.PreparableTaskModule` | 可选 | 实现 `Prepare(ctx, target)`，在任务队列开跑前批量报名/接取任务 |
| `core.ScheduledTaskModule` | 可选 | 实现 `RunScheduled(ctx, target)`，配合 `Meta().DefaultHours` / `AfterCheckin` 自动接入定时排程 |

### 关键元数据字段（`core.TaskModuleMeta`）

- `ID`：全局唯一标识，推荐 `<vendor>.<activity>`（如 `"trae.ug"`、`"codearts.ops_benefit"`）。
- `VendorIDs`：适用的供应商实例 ID 列表（精确区分国内/国际版，如 `[]string{"traecn"}`）。
- `Kind`：任务族标识（用于排程与队列过滤，如 `"ug"`、`"ops_benefit"`）。
- `Category`：展示分类常量：`core.TaskCategoryDaily` / `TaskCategoryActivity` / `TaskCategoryBenefit` / `TaskCategoryCampaign`。
- `UsesChat`：是否发起真实对话并消耗账号额度。前端弹窗确认文案会根据该标记动态生成提醒，**禁止在前端硬编码渠道说明**。
- `SupportsScan`：若实现了 `ScannableTaskModule`，注册表会自动置为 `true`。
- `AutoEligible`：是否纳入任务中心「一键做任务」批处理；若为 `false`，仍可在任务中心通过单模块「执行此模块」按钮手动触发。
- `Priority`：同渠道内多个模块的执行先后（数值越小越先执行）。

---

## 2. 最小接入模板（2 步完成新活动开发）

### 第 1 步：在 `internal/taskmods/` 新建独立模块文件

参考样板：[trae_ug.go](../internal/taskmods/trae_ug.go) 与 [codearts_ops_benefit.go](../internal/taskmods/codearts_ops_benefit.go)。

```go
package taskmods

import (
	"context"

	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/vendors/example"
)

const ModuleIDExampleSpring = "example.spring_campaign"

type exampleSpringModule struct{}

func NewExampleSpring() core.TaskModule { return exampleSpringModule{} }

func (exampleSpringModule) Meta() core.TaskModuleMeta {
	return core.TaskModuleMeta{
		ID:           ModuleIDExampleSpring,
		VendorIDs:    []string{example.VendorIDCN},
		Kind:         "spring_campaign",
		Category:     core.TaskCategoryCampaign,
		Name:         "春季限时积分活动",
		Description:  "扫描并一键领取春季限时活动奖励（不消耗对话额度）",
		UsesChat:     false,
		SupportsScan: true,
		AutoEligible: true,
		Priority:     30,
	}
}

func (exampleSpringModule) Applicable(target core.TaskModuleTarget) (bool, string) {
	if target.Vendor == nil || target.Vendor.ID() != example.VendorIDCN {
		return false, "仅适用于国内版渠道"
	}
	if target.Cred == nil {
		return false, "账号凭证为空"
	}
	return true, ""
}

// 可选：实现 ScannableTaskModule 后自动接入「扫描待办」与「待办队列」
func (exampleSpringModule) Inspect(ctx context.Context, target core.TaskModuleTarget) (core.TaskInspection, error) {
	// 调用上游只读查询接口，返回待办条目（引擎会自动补齐 ModuleID 与 KindLabel）
	return core.TaskInspection{
		InPeriod: true,
		Items: []core.TaskItem{{
			Kind:      "spring_campaign",
			KindLabel: "春季活动",
			Code:      "spring_gift",
			Title:     "领取春季活动礼包",
			Current:   0,
			Target:    1,
			UsesChat:  false,
		}},
	}, nil
}

func (exampleSpringModule) Run(ctx context.Context, target core.TaskModuleTarget, code string) ([]core.AutoTaskResult, error) {
	// code == "" 时执行模块全量动作；code 非空时只执行对应子任务
	return []core.AutoTaskResult{{
		Code:    core.FirstNonEmpty(code, "spring_gift"),
		Status:  core.AutoStatusDone,
		Message: "领取成功",
		Credit:  100,
	}}, nil
}

var (
	_ core.TaskModule          = exampleSpringModule{}
	_ core.ScannableTaskModule = exampleSpringModule{}
)
```

### 第 2 步：在组合根注册 1 行（`internal/app/taskmods.go`）

在 `BuiltinTaskModules` 的 `explicit` 切片中追加你的模块构造函数：

```go
explicit := []core.TaskModule{
	taskmods.NewTraeUG(),
	taskmods.NewCodeArtsOpsBenefit(),
	taskmods.NewExampleSpring(), // <- 新增 1 行即可
}
```

注册完成后，以下链路全部自动生效，无需修改任何其他文件：
1. `GET /tasks/modules` 自动返回新模块元数据；
2. `GET /vendors` 与 `GET /status` 自动补充该渠道与账号的 `supports_tasks` / `task_modules` 能力标记；
3. 前端「任务中心」自动在左侧任务渠道栏与「已挂载任务模块」卡片区渲染该模块及其一键执行入口；
4. 若实现 `ScannableTaskModule`，自动参与「扫描待办」和「执行待办队列」；
5. 若声明 `DefaultHours` / `AfterCheckin` 并实现 `ScheduledTaskModule`，自动接入定时调度器与「运行期设置」排程表单。

---

## 3. 分层边界与开发检查清单

- `internal/taskmods` **允许依赖**：`internal/core`、对应 `internal/vendors/<name>`、`internal/hostbridge`、`internal/logger`、`internal/safe` 与 Go 标准库。
- `internal/taskmods` **禁止依赖**：`internal/tasks`、`internal/admin`、`internal/app`、`internal/auth`、`internal/state`。
- **绝不修改供应商凭证文件**：不要直接调用 `host.auth.save`；如需复用供应商签名/请求头，请在对应 `internal/vendors/<name>/tasks.go` 暴露纯工具函数（参考 `codearts.InspectOpsActivities` / `codearts.RunOpsActivities`）。
- **活动停用**：限时活动结束后，从 `internal/app/taskmods.go` 的启用列表移除该模块，保留实现和测试。独立活动须从扫描、一键执行、手动路由和排程同时退出。新一期上线时，核对上游活动标识与资格条件，再恢复注册。
- **WorkBuddy 2026 开学季**：已知新生福利窗口截至 2026 年 10 月 31 日。`internal/vendors/workbuddy/tasks.go` 中的 `schoolSeasonEnabled` 控制旧活动入口，默认关闭。以后重开时先确认新的活动期与上游响应，再启用该开关。扫描仍受上游 `in_period` 限制。[WorkBuddy 官方活动规则](https://www.workbuddy.cn/events/campus-freshman/)
- **账号活动资格**：CodeArts 运营活动和 Trae 活动中心按上游的当前账号响应列出待办。华为云码道 Skill 创新大赛公告所列领取窗口截至 2026 年 12 月 5 日，具体账号资格仍以活动列表为准。[华为云官方活动规则](https://support.huaweicloud.com/offers-codeartsagent/codeartsagent_offers_0008.html)
- **验证命令**：
  ```bash
  ./scripts/godocker.sh test ./internal/core/... ./internal/taskmods/... ./internal/tasks/... ./internal/admin/... ./tests/...
  node --test tests/ui/*.test.mjs
  ```
