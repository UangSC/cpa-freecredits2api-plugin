package app

import (
	"encoding/json"
	"testing"

	"cpa-tierbridge2api-plugin/cpasdk/pluginapi"
)

func TestExecutorRestoresOfficialModelWithoutChangingOtherFields(t *testing.T) {
	a, errNew := New(Options{Factories: BuiltinFactories()})
	if errNew != nil {
		t.Fatal(errNew)
	}
	request, errMarshal := json.Marshal(executorRPCRequest{ExecutorRequest: pluginapi.ExecutorRequest{
		Model:       "opencodezen:zen-model",
		Format:      formatChatCompletions,
		StorageJSON: []byte(`{"vendor":"opencodezen","api_key":"sk-local-test"}`),
		Payload:     []byte(`{"model":"opencodezen:zen-model","seed":9007199254740993,"messages":[]}`),
	}})
	if errMarshal != nil {
		t.Fatal(errMarshal)
	}
	prepared, errPrepare := a.prepareExecution(request)
	if errPrepare != nil {
		t.Fatal(errPrepare)
	}
	upstream := prepared.executeRequest()
	var payload map[string]json.RawMessage
	if errDecode := json.Unmarshal(upstream.Payload, &payload); errDecode != nil {
		t.Fatal(errDecode)
	}
	if upstream.Model != "zen-model" || string(payload["model"]) != `"zen-model"` {
		t.Fatalf("出站模型未统一为官方 ID，model = %q，payload = %s", upstream.Model, upstream.Payload)
	}
	if string(payload["seed"]) != "9007199254740993" {
		t.Fatalf("还原模型时改变了其他字段的精度，seed = %s", payload["seed"])
	}
}
