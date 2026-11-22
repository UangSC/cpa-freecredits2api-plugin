package admin

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/core"
)

type stubAdminTaskMod struct {
	meta core.TaskModuleMeta
}

func (m stubAdminTaskMod) Meta() core.TaskModuleMeta { return m.meta }

func (m stubAdminTaskMod) Applicable(target core.TaskModuleTarget) (bool, string) {
	return target.Vendor != nil && m.meta.SupportsVendor(target.Vendor.ID()), "不适用"
}

func (m stubAdminTaskMod) Run(_ context.Context, _ core.TaskModuleTarget, _ string) ([]core.AutoTaskResult, error) {
	return []core.AutoTaskResult{{Code: m.meta.Kind, Status: core.AutoStatusDone, Message: "ok"}}, nil
}

func TestTasksModulesRouteAndRegistration(t *testing.T) {
	service := newService(t)
	if err := service.registry.Register(&fakeVendor{Meta: core.Meta{VendorID: "democn", VendorRegion: "cn"}}); err != nil {
		t.Fatal(err)
	}
	reg := core.NewTaskRegistry()
	if err := reg.Register(stubAdminTaskMod{meta: core.TaskModuleMeta{
		ID:           "demo.campaign",
		VendorIDs:    []string{"democn"},
		Kind:         "campaign",
		Category:     core.TaskCategoryCampaign,
		Name:         "示例限时活动",
		AutoEligible: true,
		Manual:       true,
		Route:        "/demo/claim",
	}}); err != nil {
		t.Fatalf("Register: %v", err)
	}
	service.tasks.SetModules(reg)

	foundRoute, foundManual := false, false
	for _, route := range service.Registration().Routes {
		if route.Path == "/plugins/freetier2api/tasks/modules" && route.Method == "GET" {
			foundRoute = true
		}
		if route.Path == "/plugins/freetier2api/demo/claim" && route.Method == "POST" {
			foundManual = true
		}
	}
	if !foundRoute {
		t.Fatal("GET /tasks/modules route must be registered")
	}
	if !foundManual {
		t.Fatal("模块声明的手动路由未注册")
	}
	if _, scheduled := service.tasks.Catalog().SpecByKind("campaign"); scheduled {
		t.Fatal("没有排程能力的手动模块不应进入排程设置")
	}

	raw, err := service.Handle([]byte(`{"method":"GET","path":"/plugins/freetier2api/tasks/modules"}`))
	if err != nil {
		t.Fatalf("Handle /tasks/modules: %v", err)
	}
	var envelope struct {
		Result pluginapi.ManagementResponse `json:"result"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if envelope.Result.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", envelope.Result.StatusCode)
	}
	if !strings.Contains(string(envelope.Result.Body), `"demo.campaign"`) {
		t.Fatalf("body = %s, want demo.campaign", envelope.Result.Body)
	}
}
