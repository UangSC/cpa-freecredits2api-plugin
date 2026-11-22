package tasks

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"cpa-tierbridge2api-plugin/internal/core"
)

type stubTaskModule struct {
	meta         core.TaskModuleMeta
	applicableFn func(core.TaskModuleTarget) (bool, string)
	inspectItems []core.TaskItem
	runResults   []core.AutoTaskResult
	scheduledMsg string
	runCalls     []string
	schedCalls   int
	prepareCalls int
}

func (m *stubTaskModule) Meta() core.TaskModuleMeta { return m.meta }

func (m *stubTaskModule) Applicable(target core.TaskModuleTarget) (bool, string) {
	if m.applicableFn != nil {
		return m.applicableFn(target)
	}
	return target.Vendor != nil && m.meta.SupportsVendor(target.Vendor.ID()), "不适用"
}

func (m *stubTaskModule) Inspect(_ context.Context, _ core.TaskModuleTarget) (core.TaskInspection, error) {
	return core.TaskInspection{Items: m.inspectItems, InPeriod: len(m.inspectItems) > 0}, nil
}

func (m *stubTaskModule) Run(_ context.Context, _ core.TaskModuleTarget, code string) ([]core.AutoTaskResult, error) {
	m.runCalls = append(m.runCalls, code)
	if len(m.runResults) > 0 {
		return m.runResults, nil
	}
	return []core.AutoTaskResult{{Code: core.FirstNonEmpty(code, m.meta.Kind), Status: core.AutoStatusDone, Message: "ok"}}, nil
}

func (m *stubTaskModule) RunScheduled(_ context.Context, _ core.TaskModuleTarget) (string, error) {
	m.schedCalls++
	return m.scheduledMsg, nil
}

func (m *stubTaskModule) Prepare(context.Context, core.TaskModuleTarget) int {
	m.prepareCalls++
	return 0
}

// TestModuleDrivenScanAndQueue 验证 TaskRegistry 驱动的扫描、通用 tasks JSON 输出与按模块队列过滤。
func TestModuleDrivenScanAndQueue(t *testing.T) {
	reg := core.NewTaskRegistry()
	mod := &stubTaskModule{
		meta: core.TaskModuleMeta{
			ID:           "demo.benefit",
			VendorIDs:    []string{"democn"},
			Kind:         "benefit",
			Name:         "示例活动福利",
			SupportsScan: true,
			AutoEligible: true,
		},
		inspectItems: []core.TaskItem{
			{Kind: "benefit", Code: "claim_1", RunCode: "benefit_all", Title: "领取活动福利", Current: 0, Target: 1},
			{Kind: "benefit", Code: "claim_2", RunCode: "benefit_all", Title: "领取额外礼包", Current: 0, Target: 1},
		},
	}
	if err := reg.Register(mod); err != nil {
		t.Fatalf("Register: %v", err)
	}

	service := &Service{deps: newFakeDeps(time.Date(2026, 11, 22, 10, 0, 0, 0, checkinZone))}
	service.SetModules(reg)

	demoAcct := &accountContext{
		vendor:     &fakeCheckinVendor{id: "democn"},
		credential: &core.Credential{FileID: "demo-1", Label: "DemoUser"},
	}
	plainAcct := &accountContext{
		vendor:     &fakeCheckinVendor{id: "cline"},
		credential: &core.Credential{FileID: "cline-1", Label: "ClineUser"},
	}

	if len(service.scannableModules(plainAcct, nil)) != 0 {
		t.Fatal("non-task vendor should have zero scannable modules")
	}
	scan := service.scanOneAccount(context.Background(), demoAcct, service.scannableModules(demoAcct, nil))
	if scan.VendorID != "democn" || len(scan.Tasks) != 2 || !scan.InPeriod {
		t.Fatalf("unexpected scan = %+v", scan)
	}
	if scan.Tasks[0].ModuleID != "demo.benefit" || scan.Tasks[0].KindLabel != "示例活动福利" {
		t.Fatalf("scan should enrich module_id and kind_label: %+v", scan.Tasks[0])
	}

	raw, errMarshal := json.Marshal(scan)
	if errMarshal != nil {
		t.Fatalf("marshal scan: %v", errMarshal)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal scan: %v", err)
	}
	tasksSlice, ok := decoded["tasks"].([]any)
	if !ok || len(tasksSlice) != 2 {
		t.Fatalf("scan JSON must expose generic tasks field: %s", raw)
	}

	items := service.buildQueueItemsFiltered([]accountScan{scan}, nil, map[string]bool{"demo.benefit": true})
	if len(items) != 1 || items[0].Code != "benefit_all" || items[0].ModuleID != "demo.benefit" {
		t.Fatalf("queue items = %+v, want collapsed single item", items)
	}

	res, errRun := service.runTaskForAccountWithModule(context.Background(), demoAcct, "benefit_all", "demo.benefit")
	if errRun != nil || res.Status != core.AutoStatusDone {
		t.Fatalf("runTaskForAccountWithModule = %+v / %v", res, errRun)
	}
	if len(mod.runCalls) != 1 || mod.runCalls[0] != "benefit_all" {
		t.Fatalf("runCalls = %v", mod.runCalls)
	}
}

// TestModuleDrivenAutoAndScheduledIsolation 验证无任务模块渠道被精确隔离，且定时模块可独立执行。
func TestModuleDrivenAutoAndScheduledIsolation(t *testing.T) {
	reg := core.NewTaskRegistry()
	mod := &stubTaskModule{
		meta: core.TaskModuleMeta{
			ID:           "demo.daily",
			VendorIDs:    []string{"democn"},
			Kind:         "demo_daily",
			Name:         "示例日常",
			AutoEligible: true,
			DefaultHours: []int{9},
		},
		scheduledMsg: "demo scheduled ok",
	}
	if err := reg.Register(mod); err != nil {
		t.Fatalf("Register: %v", err)
	}

	service := &Service{deps: newFakeDeps(time.Date(2026, 11, 22, 10, 0, 0, 0, checkinZone))}
	service.SetModules(reg)

	demoAcct := &accountContext{
		vendor:     &fakeCheckinVendor{id: "democn"},
		credential: &core.Credential{FileID: "demo-1", Label: "DemoUser"},
	}
	plainAcct := &accountContext{
		vendor:     &fakeCheckinVendor{id: "opencodezen"},
		credential: &core.Credential{FileID: "zen-1", Label: "ZenUser"},
	}

	if got := service.matchingAutoModules(plainAcct, nil); len(got) != 0 {
		t.Fatalf("opencodezen should have 0 auto modules, got %d", len(got))
	}
	if got := service.matchingAutoModules(demoAcct, nil); len(got) != 1 {
		t.Fatalf("democn should have 1 auto module, got %d", len(got))
	}

	results := service.runAutoAll(context.Background(), demoAcct)
	if len(results) != 1 || results[0].ModuleID != "demo.daily" || results[0].Status != core.AutoStatusDone {
		t.Fatalf("runAutoAll = %+v", results)
	}

	msg, errSched := service.runScheduledForAccount(context.Background(), demoAcct, "demo_daily", false)
	if errSched != nil || msg != "demo scheduled ok" || mod.schedCalls != 1 {
		t.Fatalf("runScheduledForAccount = %q / %v (calls=%d)", msg, errSched, mod.schedCalls)
	}
	msgPlain, errPlain := service.runScheduledForAccount(context.Background(), plainAcct, "demo_daily", false)
	if errPlain != nil || msgPlain != "" {
		t.Fatalf("plain vendor scheduled should be skipped, got %q / %v", msgPlain, errPlain)
	}
	if message, err := service.runScheduledForAccount(context.Background(), demoAcct, "demo_daily", true); err != nil || message != "" || mod.schedCalls != 1 {
		t.Fatalf("无签到联动的模块被触发：%q / %v，计数 %d", message, err, mod.schedCalls)
	}
}

func TestQueuePreparesOnlySelectedModule(t *testing.T) {
	reg := core.NewTaskRegistry()
	active := &stubTaskModule{meta: core.TaskModuleMeta{ID: "demo.selected", VendorIDs: []string{"democn"}}}
	other := &stubTaskModule{meta: core.TaskModuleMeta{ID: "demo.unselected", VendorIDs: []string{"democn"}}}
	for _, mod := range []core.TaskModule{active, other} {
		if err := reg.Register(mod); err != nil {
			t.Fatal(err)
		}
	}
	service := New(newFakeDeps(time.Now()))
	service.SetModules(reg)
	account := &accountContext{vendor: &fakeCheckinVendor{id: "democn"}, credential: &core.Credential{FileID: "a"}}
	service.queue.items = []queueItem{{UID: "a", Code: "claim", ModuleID: active.meta.ID, Status: "pending"}}
	service.runQueueJob(context.Background(), queueJob{account: account, indices: []int{0}})
	if active.prepareCalls != 1 || len(active.runCalls) != 1 || other.prepareCalls != 0 || len(other.runCalls) != 0 {
		t.Fatalf("队列执行越过模块范围：%+v / %+v", active, other)
	}
	if _, err := service.runTaskForAccountWithModule(context.Background(), account, "claim", "unknown"); err == nil {
		t.Fatal("未知模块应明确失败")
	}
	if _, err := service.runTaskForAccountWithModule(context.Background(), account, "claim", ""); err == nil {
		t.Fatal("账号存在多个模块时应要求明确指定")
	}
}
