package taskmods

import (
	"context"
	"testing"

	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/vendors/codearts"
	"cpa-freecredits2api-plugin/internal/vendors/trae"
)

type minimalVendor struct {
	core.Meta
}

func (minimalVendor) Match(string, string, map[string]any) bool { return false }
func (minimalVendor) Parse([]byte, string) (*core.Credential, error) {
	return nil, nil
}
func (minimalVendor) StaticModels(context.Context) ([]pluginapi.ModelInfo, error) { return nil, nil }
func (minimalVendor) Execute(context.Context, *core.Credential, *core.ExecuteRequest) (*pluginapi.ExecutorResponse, error) {
	return nil, nil
}
func (minimalVendor) ExecuteStream(context.Context, *core.Credential, *core.ExecuteRequest, core.StreamSink) error {
	return nil
}

type runnerStubVendor struct {
	minimalVendor
}

func (runnerStubVendor) RunTask(context.Context, *core.Credential, string) (core.TaskRunResult, error) {
	return core.TaskRunResult{Status: core.AutoStatusDone, Message: "ok"}, nil
}
func (runnerStubVendor) RunAllTasks(context.Context, *core.Credential) []core.AutoTaskResult {
	return []core.AutoTaskResult{{Code: "demo", Status: core.AutoStatusDone}}
}

func TestSampleModulesIsolation(t *testing.T) {
	traeMod := NewTraeUG()
	if !traeMod.Meta().SupportsVendor(trae.VendorIDCN) || traeMod.Meta().SupportsVendor(trae.VendorIDGlobal) {
		t.Fatalf("trae.ug should only target traecn: %+v", traeMod.Meta().VendorIDs)
	}
	if ok, _ := traeMod.Applicable(core.TaskModuleTarget{
		Vendor: &minimalVendor{Meta: core.Meta{VendorID: trae.VendorIDGlobal}},
		Cred:   &core.Credential{},
	}); ok {
		t.Fatal("trae.ug must not be applicable to traeglobal")
	}

	caMod := NewCodeArtsOpsBenefit()
	if !caMod.Meta().SupportsVendor(codearts.VendorID) || caMod.Meta().SupportsVendor("opencodezen") {
		t.Fatalf("codearts.ops_benefit vendor mismatch: %+v", caMod.Meta().VendorIDs)
	}
	if ok, _ := caMod.Applicable(core.TaskModuleTarget{
		Vendor: &minimalVendor{Meta: core.Meta{VendorID: codearts.VendorID}},
		Cred:   &core.Credential{Native: &codearts.Credential{AccessKeyID: ""}},
	}); ok {
		t.Fatal("codearts.ops_benefit must reject credential without AK")
	}
	if ok, _ := caMod.Applicable(core.TaskModuleTarget{
		Vendor: &minimalVendor{Meta: core.Meta{VendorID: codearts.VendorID}},
		Cred:   &core.Credential{Native: &codearts.Credential{AccessKeyID: "AK-OK"}},
	}); !ok {
		t.Fatal("codearts.ops_benefit should accept credential with AK")
	}
}

func TestLegacyModulesExcludeNonTaskAndCoveredVendors(t *testing.T) {
	reg := core.NewRegistry()
	for _, v := range []core.Vendor{
		&runnerStubVendor{minimalVendor{Meta: core.Meta{VendorID: "workbuddycn", VendorName: "WB CN"}}},
		&runnerStubVendor{minimalVendor{Meta: core.Meta{VendorID: "workbuddyglobal", VendorName: "WB Global"}}},
		&runnerStubVendor{minimalVendor{Meta: core.Meta{VendorID: "qodercn", VendorName: "Qoder CN"}}},
		&minimalVendor{Meta: core.Meta{VendorID: "opencodezen", VendorName: "OpenCode ZEN"}},
		&runnerStubVendor{minimalVendor{Meta: core.Meta{VendorID: "codearts", VendorName: "CodeArts"}}},
	} {
		if err := reg.Register(v); err != nil {
			t.Fatalf("register %s: %v", v.ID(), err)
		}
	}

	mods := LegacyModulesFor(reg, map[string]bool{"codearts": true})
	if len(mods) != 1 || mods[0].Meta().ID != "workbuddy.tasks" {
		t.Fatalf("expected only workbuddy.tasks, got %+v", mods)
	}
}
