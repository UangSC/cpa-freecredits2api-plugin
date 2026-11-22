package core

import (
	"context"
	"testing"
)

type stubTaskModule struct {
	meta       TaskModuleMeta
	applicable bool
	reason     string
}

func (m stubTaskModule) Meta() TaskModuleMeta { return m.meta }
func (m stubTaskModule) Applicable(TaskModuleTarget) (bool, string) {
	return m.applicable, m.reason
}
func (m stubTaskModule) Run(context.Context, TaskModuleTarget, string) ([]AutoTaskResult, error) {
	return []AutoTaskResult{{Code: m.meta.ID, Status: AutoStatusDone, Message: "ok"}}, nil
}

type stubScannableModule struct {
	stubTaskModule
}

func (m stubScannableModule) RunScheduled(context.Context, TaskModuleTarget) (string, error) {
	return "ok", nil
}

func (m stubScannableModule) Inspect(context.Context, TaskModuleTarget) (TaskInspection, error) {
	return TaskInspection{Items: []TaskItem{{Kind: m.meta.Kind, Code: "c1", Title: "t1"}}}, nil
}

func TestTaskRegistryValidationAndPriority(t *testing.T) {
	reg := NewTaskRegistry()
	if err := reg.Register(nil); err == nil {
		t.Fatal("nil module must fail")
	}
	if err := reg.Register(stubTaskModule{meta: TaskModuleMeta{ID: "no.vendor"}}); err == nil {
		t.Fatal("module without vendor_ids must fail")
	}
	late := stubTaskModule{
		meta:       TaskModuleMeta{ID: "demo.late", VendorIDs: []string{"demo"}, Kind: "late", Name: "后执行", Priority: 30, AutoEligible: true},
		applicable: true,
	}
	early := stubScannableModule{
		stubTaskModule: stubTaskModule{
			meta:       TaskModuleMeta{ID: "demo.early", VendorIDs: []string{"demo"}, Kind: "early", Name: "先执行", Priority: 10, AutoEligible: true, Manual: true, Route: "/demo/early"},
			applicable: true,
		},
	}
	if err := reg.Register(late); err != nil {
		t.Fatalf("register late: %v", err)
	}
	if err := reg.Register(early); err != nil {
		t.Fatalf("register early: %v", err)
	}
	if err := reg.Register(late); err == nil {
		t.Fatal("duplicate module id must fail")
	}

	got := reg.ForVendor("demo")
	if len(got) != 2 || got[0].Meta().ID != "demo.early" || got[1].Meta().ID != "demo.late" {
		t.Fatalf("ForVendor priority order wrong: %+v", got)
	}
	if !reg.VendorHasTasks("demo") || !reg.VendorSupportsScan("demo") || !reg.VendorSupportsAuto("demo") {
		t.Fatal("demo vendor capabilities should all be true")
	}
	if reg.VendorHasTasks("other") || reg.VendorSupportsScan("other") || reg.VendorSupportsAuto("other") {
		t.Fatal("unrelated vendor must be cleanly isolated")
	}
	specs := reg.TaskSpecs()
	if len(specs) != 1 || specs[0].Kind != "early" || specs[0].Route != "/demo/early" {
		t.Fatalf("TaskSpecs = %+v", specs)
	}
}
