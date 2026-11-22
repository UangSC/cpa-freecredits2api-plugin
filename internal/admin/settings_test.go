package admin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"cpa-tierbridge2api-plugin/cpasdk/pluginapi"
	"cpa-tierbridge2api-plugin/internal/core"
	"cpa-tierbridge2api-plugin/internal/state"
)

// TestNormalizePromptMode 锁住全局提示词过滤模式的取值集合。
func TestNormalizePromptMode(t *testing.T) {
	valid := map[string]string{
		"":            "",
		"passthrough": PromptModePassThrough,
		" CUSTOM ":    PromptModeCustom,
		"append":      PromptModeAppend,
	}
	for raw, want := range valid {
		got, err := normalizePromptMode(&raw)
		if err != nil || got != want {
			t.Errorf("normalizePromptMode(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}

	bad := "overwrite"
	_, errBad := normalizePromptMode(&bad)
	pluginErr, okErr := errBad.(*core.PluginError)
	if !okErr || pluginErr.HTTPStatus != http.StatusBadRequest {
		t.Fatalf("unsupported mode should be a 400 plugin error, got %T %v", errBad, errBad)
	}

	if got, err := normalizePromptMode(nil); err != nil || got != "" {
		t.Fatalf("absent field = %q, %v", got, err)
	}
}

// TestSettingsViewReportsEffectivePromptMode 验证 /status 回的是生效值（页面覆盖优先）。
func TestSettingsViewReportsEffectivePromptMode(t *testing.T) {
	deps := newStubDeps(t)
	service := newServiceWithDeps(t, deps)

	if got := settingsText(t, service, PromptModeKey); got != PromptModePassThrough {
		t.Fatalf("默认模式 = %q, want passthrough", got)
	}

	deps.store.Mutate(func(current *state.State) { current.PromptMode = PromptModeAppend })
	if got := settingsText(t, service, PromptModeKey); got != PromptModeAppend {
		t.Fatalf("页面覆盖未生效: %q", got)
	}
}

// settingsText 从 /status 的 settings 载荷里读一个字符串字段。
func settingsText(t *testing.T, service *Service, key string) string {
	t.Helper()
	raw, errMarshal := json.Marshal(service.settingsView())
	if errMarshal != nil {
		t.Fatalf("marshal settings: %v", errMarshal)
	}
	var settings map[string]any
	if errUnmarshal := json.Unmarshal(raw, &settings); errUnmarshal != nil {
		t.Fatalf("unmarshal settings: %v", errUnmarshal)
	}
	value, okValue := settings[key].(string)
	if !okValue {
		t.Fatalf("settings 缺少 %s: %s", key, raw)
	}
	return value
}

// TestSettingsViewReportsEffectiveModelNameTag 验证 /status 回的是生效值（页面覆盖优先）。
func TestSettingsViewReportsEffectiveModelNameTag(t *testing.T) {
	deps := newStubDeps(t)
	service := newServiceWithDeps(t, deps)

	if got := settingsText(t, service, ModelNameTagKey); got != ModelNameTagOff {
		t.Fatalf("默认标识 = %q, want off", got)
	}

	deps.store.Mutate(func(current *state.State) { current.ModelNameTag = ModelNameTagPrefix })
	if got := settingsText(t, service, ModelNameTagKey); got != ModelNameTagPrefix {
		t.Fatalf("页面覆盖未生效: %q", got)
	}
}

// TestNormalizeModelNameTagPointer 锁住页面提交的非法值必须是 400。
func TestNormalizeModelNameTagPointer(t *testing.T) {
	for raw, want := range map[string]string{
		" Prefix ": ModelNameTagPrefix,
		"suffix":   ModelNameTagSuffix,
		"off":      ModelNameTagOff,
		"":         "",
	} {
		input := raw
		got, err := normalizeModelNameTagPointer(&input)
		if err != nil || got != want {
			t.Errorf("normalizeModelNameTagPointer(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	if got, err := normalizeModelNameTagPointer(nil); err != nil || got != "" {
		t.Fatalf("absent field = %q, %v", got, err)
	}
	bad := "inline"
	_, errBad := normalizeModelNameTagPointer(&bad)
	pluginErr, okErr := errBad.(*core.PluginError)
	if !okErr || pluginErr.HTTPStatus != http.StatusBadRequest {
		t.Fatalf("unsupported tag should be a 400 plugin error, got %T %v", errBad, errBad)
	}
}

// registryDirtyOf 读出 /settings 响应里的 model_registry_dirty。
func registryDirtyOf(t *testing.T, response pluginapi.ManagementResponse) bool {
	t.Helper()
	var payload struct {
		Dirty bool `json:"model_registry_dirty"`
	}
	if err := json.Unmarshal(response.Body, &payload); err != nil {
		t.Fatalf("unmarshal settings response: %v", err)
	}
	return payload.Dirty
}

// TestSettingsRequestMarksRestartPending 验证改标识与手动别名同语义：
// 置 RestartPending 并回 model_registry_dirty，控制台据此立即触发
// syncModelConfig 重建注册表；生效值没变时两者都不出现。
func TestSettingsRequestMarksRestartPending(t *testing.T) {
	deps := newStubDeps(t)
	service := newServiceWithDeps(t, deps)

	response := service.handleSettingsRequest(pluginapi.ManagementRequest{
		Method: http.MethodPost, Body: []byte(`{"model_name_tag":"prefix"}`),
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, response.Body)
	}
	if !deps.State().RestartPending {
		t.Fatal("改 model_name_tag 应置 RestartPending")
	}
	if !registryDirtyOf(t, response) {
		t.Fatal("改 model_name_tag 应回 model_registry_dirty=true")
	}
	if got := settingsText(t, service, ModelNameTagKey); got != ModelNameTagPrefix {
		t.Fatalf("保存后生效值 = %q", got)
	}

	// 重复提交同一生效值不该再触发注册表重建。
	deps.store.Mutate(func(current *state.State) { current.RestartPending = false })
	response = service.handleSettingsRequest(pluginapi.ManagementRequest{
		Method: http.MethodPost, Body: []byte(`{"model_name_tag":"prefix"}`),
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, response.Body)
	}
	if deps.State().RestartPending {
		t.Fatal("生效值未变时不应置 RestartPending")
	}
	if registryDirtyOf(t, response) {
		t.Fatal("生效值未变时不应回 model_registry_dirty=true")
	}
}

type settingsTaskVendor struct{ fakeVendor }

func (*settingsTaskVendor) TaskSpecs() []core.TaskSpec {
	return []core.TaskSpec{{Kind: "keepalive", DefaultHours: []int{9, 21}}}
}

func TestSettingsScheduleResetKeepsDefaultAndUnrelatedOverrides(t *testing.T) {
	deps := newStubDeps(t)
	vendor := &settingsTaskVendor{fakeVendor{Meta: core.Meta{VendorID: "settings-test"}}}
	if err := deps.registry.Register(vendor); err != nil {
		t.Fatal(err)
	}
	service := newServiceWithDeps(t, deps)
	if err := deps.SaveStateChange(func(current *state.State) {
		current.TaskSchedules["keepalive"] = []int{3}
		current.TaskSchedules["legacy"] = []int{4}
	}); err != nil {
		t.Fatal(err)
	}
	resp := service.handleSettingsRequest(pluginapi.ManagementRequest{
		Body: []byte(`{"task_schedules":{"keepalive":[]}}`),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, resp.Body)
	}
	stored := deps.State().TaskSchedules
	if _, exists := stored["keepalive"]; exists || len(stored["legacy"]) != 1 {
		t.Fatalf("unexpected schedule overrides: %+v", stored)
	}
	var payload struct {
		Settings struct {
			Schedule  map[string][]int `json:"schedule"`
			Overrides map[string][]int `json:"task_schedule_overrides"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(resp.Body, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Settings.Schedule["keepalive"]) == 0 || len(payload.Settings.Overrides) != 0 {
		t.Fatalf("response should contain effective defaults and no active overrides: %s", resp.Body)
	}
}

func TestSettingsWriteFailureKeepsPreviousState(t *testing.T) {
	deps := newStubDeps(t)
	dir := t.TempDir()
	deps.store.Configure(dir)
	if err := deps.SaveStateChange(func(current *state.State) { current.PromptMode = PromptModeAppend }); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "state.json.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	service := newServiceWithDeps(t, deps)
	resp := service.handleSettingsRequest(pluginapi.ManagementRequest{
		Body: []byte(`{"prompt_mode":"custom","model_name_tag":"suffix"}`),
	})
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("write failure reported as success: %s", resp.Body)
	}
	stored := deps.State()
	if stored.PromptMode != PromptModeAppend || stored.ModelNameTag != "" || stored.RestartPending {
		t.Fatalf("failed save changed runtime state: %+v", stored)
	}
}
