package tests

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cpa-freecredits2api-plugin/cpasdk/pluginabi"
	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/app"
	"cpa-freecredits2api-plugin/internal/core"
)

func TestExecutorModelCooldownAndCredentialScope(t *testing.T) {
	const model = "cn:glm-5.2"
	const otherModel = "cn:deepseek-v4.1-flash"
	for _, tc := range []struct {
		name      string
		models    []string
		knownGood bool
		scoped    bool
		paused    bool
	}{
		{name: "single model cools the credential without disabling it", models: []string{model}, scoped: true, paused: true},
		{name: "multiple models pause only the failing model", models: []string{model, otherModel}, paused: true},
		{name: "missing registry evidence keeps cooldown model scoped", paused: true},
		{name: "successful model keeps timed backoff", models: []string{model}, knownGood: true, scoped: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := installFakeHost(t)
			const fileName = "workbuddycn-cooldown.json"
			credentialJSON := sampleCredentialJSON("cn", "cooldown")
			authPath := filepath.Join(t.TempDir(), fileName)
			if err := os.WriteFile(authPath, []byte(credentialJSON), 0o600); err != nil {
				t.Fatal(err)
			}
			host.addAccount("cooldown-index", fileName, credentialJSON)
			host.SetAuthFilePath("cooldown-index", authPath)
			clock := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
			cfg := app.DefaultConfig()
			cfg.StateDir = t.TempDir()
			cfg.LogToFile = false
			cfg.LogLevel = "error"
			upstreamModels := make([]map[string]string, 0, len(tc.models))
			for _, id := range tc.models {
				upstreamModels = append(upstreamModels, map[string]string{"id": strings.TrimPrefix(id, "cn:")})
			}
			configBody := string(mustMarshal(map[string]any{"code": 0, "data": map[string]any{"models": upstreamModels}}))
			host.setUpstream(func(_ string, url string, _ string) fakeUpstreamResponse {
				if strings.Contains(url, "/v3/config") {
					return fakeUpstreamResponse{Status: http.StatusOK, Body: configBody}
				}
				return fakeUpstreamResponse{Status: http.StatusTooManyRequests, Body: `{"error":{"data":{"code":14018,"msg":"Credits exhausted"}}}`}
			})
			start := func() *app.App {
				instance, err := app.New(app.Options{Factories: app.BuiltinFactories(), Now: func() time.Time { return clock }})
				if err != nil {
					t.Fatal(err)
				}
				if err := instance.ApplyConfig(cfg); err != nil {
					t.Fatal(err)
				}
				if _, err := instance.LoadState(cfg); err != nil {
					t.Fatal(err)
				}
				if len(tc.models) > 0 {
					_, err = instance.HandleMethod(pluginabi.MethodModelForAuth, mustMarshal(map[string]any{
						"AuthID": fileName, "host_callback_id": testCallbackID,
					}))
					if err != nil {
						t.Fatal(err)
					}
				}
				t.Cleanup(instance.StopBackgroundWork)
				return instance
			}
			instance := start()
			request := app.ExecutorRPCRequest{
				HostCallbackID: testCallbackID,
				ExecutorRequest: pluginapi.ExecutorRequest{
					AuthID: fileName, Model: model, Payload: []byte(`{"model":"cn:glm-5.2","messages":[]}`),
				},
			}
			checkSuccess := func(request app.ExecutorRPCRequest) {
				t.Helper()
				host.setUpstream(func(string, string, string) fakeUpstreamResponse {
					return fakeUpstreamResponse{Status: http.StatusOK, Body: `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"}
				})
				if _, err := instance.HandleMethod(pluginabi.MethodExecutorExecute, mustMarshal(request)); err != nil {
					t.Fatal(err)
				}
			}
			if tc.knownGood {
				checkSuccess(request)
				host.setUpstream(func(_ string, url string, _ string) fakeUpstreamResponse {
					if strings.Contains(url, "/v3/config") {
						return fakeUpstreamResponse{Status: http.StatusOK, Body: configBody}
					}
					return fakeUpstreamResponse{Status: http.StatusTooManyRequests, Body: `{"error":{"data":{"code":14018,"msg":"Credits exhausted"}}}`}
				})
			}
			checkFailure := func() *pluginabi.Error {
				t.Helper()
				_, err := instance.HandleMethod(pluginabi.MethodExecutorExecute, mustMarshal(request))
				if err == nil {
					t.Fatal("expected executor to report quota exhaustion")
				}
				var envelope pluginabi.Envelope
				if decodeErr := json.Unmarshal(core.ErrorEnvelopeFromError(err), &envelope); decodeErr != nil {
					t.Fatal(decodeErr)
				}
				if failure := envelope.Error; failure != nil && failure.HTTPStatus == http.StatusTooManyRequests && failure.CredentialScoped == tc.scoped {
					return failure
				}
				t.Fatalf("expected a 429 with credential_scoped=%v, got %+v", tc.scoped, envelope.Error)
				return nil
			}
			for index, expected := range []time.Duration{30 * time.Minute, time.Hour, 2 * time.Hour, 4 * time.Hour, 8 * time.Hour} {
				if failure := checkFailure(); failure.RetryAfterSeconds != int(expected/time.Second) {
					t.Fatalf("failure %d: retry hint = %d, want %v", index+1, failure.RetryAfterSeconds, expected)
				}
				if index == 1 {
					instance.StopBackgroundWork()
					instance = start()
				}
				calls := host.UpstreamCalls()
				if failure := checkFailure(); failure.Code != pluginabi.ErrorCodeTransientRateLimit || host.UpstreamCalls() != calls {
					t.Fatalf("failure %d: active cooldown reached upstream", index+1)
				}
				if host.SnapshotAuthFiles()[0].Disabled {
					t.Fatalf("credential disabled after only %d failures", index+1)
				}
				clock = clock.Add(expected)
			}
			checkFailure()
			if host.SnapshotAuthFiles()[0].Disabled {
				t.Fatal("automatic cooling disabled the credential")
			}
			cooldown := instance.SnapshotState().ModelCooldowns["workbuddycn-cooldown"]["glm-5.2"]
			if cooldown.Paused != tc.paused {
				t.Fatalf("model pause state = %+v, want paused = %v", cooldown, tc.paused)
			}
			if len(tc.models) > 1 {
				alternative := request
				alternative.Model = otherModel
				checkSuccess(alternative)
				calls := host.UpstreamCalls()
				if failure := checkFailure(); failure.RetryAfterSeconds != 60 || host.UpstreamCalls() != calls {
					t.Fatal("paused model reached upstream or lost the recovery interval")
				}
				testApp = instance
				t.Cleanup(func() { testApp = nil })
				response := managementCallWithBody(t, http.MethodPost, "/accounts/models/resume", map[string]string{
					"file_id": "workbuddycn-cooldown", "model": "GLM-5.2",
				})
				if response.StatusCode != http.StatusOK {
					t.Fatalf("model resume failed: %s", response.Body)
				}
				models := instance.SnapshotState().ModelCooldowns["workbuddycn-cooldown"]
				if models["glm-5.2"].Paused || models["glm-5.2"].ResetAt.IsZero() || !models["deepseek-v4.1-flash"].Verified {
					t.Fatalf("resume changed the wrong model state: %+v", models)
				}
			}
		})
	}
}

func TestExecutorModelRateLimitDoesNotBlockOtherModels(t *testing.T) {
	host := installFakeHost(t)
	setupTestPlugin(t)
	host.addAccount("model-limit-index", "workbuddycn-model-limit.json", sampleCredentialJSON("cn", "model-limit"))
	host.setUpstream(func(string, string, string) fakeUpstreamResponse {
		return fakeUpstreamResponse{Status: http.StatusTooManyRequests, Body: `{"code":6004,"msg":"model frequency limit"}`}
	})
	for _, model := range []string{"cn:hy4flash-free", "cn:deepseek-v4.1-flash"} {
		request := mustMarshal(app.ExecutorRPCRequest{
			HostCallbackID:  testCallbackID,
			ExecutorRequest: pluginapi.ExecutorRequest{AuthID: "model-limit-index", Model: model, Payload: []byte(`{"messages":[]}`)},
		})
		_, err := testApp.HandleMethod(pluginabi.MethodExecutorExecute, request)
		var failure *core.PluginError
		if !errors.As(err, &failure) || failure.Code != "upstream_soft_rate" || failure.ABIError().CredentialScoped || failure.RetryAfterSeconds != 10 {
			t.Fatalf("model %s: expected model-only rate limit, got %v", model, err)
		}
		calls := host.UpstreamCalls()
		if _, err = testApp.HandleMethod(pluginabi.MethodExecutorExecute, request); !errors.As(err, &failure) || host.UpstreamCalls() != calls {
			t.Fatalf("model %s: repeated request reached the upstream during rate limiting", model)
		}
	}
	if calls := host.UpstreamCalls(); calls != 2 {
		t.Fatalf("expected both models to reach upstream, got %d calls", calls)
	}
}

func TestExecutorModelPoolKeepsStartedStream(t *testing.T) {
	host := installFakeHost(t)
	setupTestPlugin(t)
	const fileName = "workbuddycn-stream-pool.json"
	host.addAccount("stream-pool-index", fileName, sampleCredentialJSON("cn", "stream-pool"))
	host.setUpstream(func(_ string, url, body string) fakeUpstreamResponse {
		if strings.Contains(url, "/v3/config") {
			return fakeUpstreamResponse{Status: http.StatusOK, Body: `{"code":0,"data":{"models":[{"id":"glm-5.2"},{"id":"deepseek-v4.1-flash"}]}}`}
		}
		var request struct{ Model string }
		if err := json.Unmarshal([]byte(body), &request); err != nil {
			return fakeUpstreamResponse{Status: http.StatusBadRequest}
		}
		switch request.Model {
		case "glm-5.2":
			return fakeUpstreamResponse{Status: http.StatusOK, Body: "data: {\"choices\":[{\"delta\":{\"content\":\"primary output\"}}]}\n\n" +
				"data: {\"error\":{\"data\":{\"code\":14018,\"msg\":\"Credits exhausted\"}}}\n\n"}
		case "deepseek-v4.1-flash":
			return fakeUpstreamResponse{Status: http.StatusOK, Body: "data: {\"choices\":[{\"delta\":{\"content\":\"backup output\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"}
		default:
			return fakeUpstreamResponse{Status: http.StatusNotFound}
		}
	})
	for _, id := range []string{"glm-5.2", "deepseek-v4.1-flash"} {
		response := managementCallWithBody(t, http.MethodPost, "/models/alias", map[string]string{
			"model": "workbuddycn:" + id, "alias": "shared-stream",
		})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("save alias: %s", response.Body)
		}
	}
	response := managementCallWithBody(t, http.MethodPost, "/models/priority", map[string]any{
		"model": "workbuddycn:glm-5.2", "priority": 9,
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("save priority: %s", response.Body)
	}
	callMethod(t, pluginabi.MethodModelForAuth, map[string]any{"AuthID": fileName, "host_callback_id": testCallbackID})
	request := app.ExecutorRPCRequest{
		HostCallbackID: testCallbackID,
		StreamID:       "stream-pool",
		ExecutorRequest: pluginapi.ExecutorRequest{
			AuthID: fileName, Model: "shared-stream", Stream: true, Payload: []byte(`{"model":"shared-stream","messages":[]}`),
		},
	}
	calls := host.UpstreamCalls()
	callMethod(t, pluginabi.MethodExecutorExecuteStream, request)
	if !waitFor(t, 2*time.Second, func() bool { return len(host.closedStreams()) == 1 }) {
		t.Fatal("stream did not close")
	}
	if host.UpstreamCalls() != calls+1 || !strings.Contains(strings.Join(host.emittedChunks(), ""), "primary output") ||
		!strings.Contains(strings.Join(host.streamErrors(), ""), "Credits exhausted") {
		t.Fatalf("started stream switched candidates or lost its error: chunks=%v errors=%v", host.emittedChunks(), host.streamErrors())
	}
	request.Stream = false
	raw := callMethod(t, pluginabi.MethodExecutorExecute, request)
	var result pluginapi.ExecutorResponse
	if err := json.Unmarshal(raw, &result); err != nil || !strings.Contains(string(result.Payload), "backup output") {
		t.Fatalf("next request did not use the healthy candidate: %s", raw)
	}
}
