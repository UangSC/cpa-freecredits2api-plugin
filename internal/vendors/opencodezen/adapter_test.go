package opencodezen

import (
	"testing"

	"cpa-tierbridge2api-plugin/internal/core"
)

func TestConfigureBaseURLPerInstance(t *testing.T) {
	v := Instances(core.Env{})[0].(*adapter)
	v.Configure(core.Settings{}, map[string]string{"opencodezen_base_url": "http://zen.test"})
	if v.baseURL.Load() != "http://zen.test" {
		t.Fatalf("baseURL = %q", v.baseURL.Load())
	}
}
