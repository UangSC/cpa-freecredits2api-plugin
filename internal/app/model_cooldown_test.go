package app

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/state"
)

func TestModelCooldownGrowsFromUpstreamWait(t *testing.T) {
	now := time.Now()
	previous := advanceModelCooldown(state.ModelCooldown{}, now, 10*time.Second)
	next := advanceModelCooldown(previous, previous.RetryAt, 10*time.Second)
	if previous.Delay != 10*time.Second || next.Delay != 20*time.Second {
		t.Fatalf("cooldowns = %v then %v, want 10s then 20s", previous.Delay, next.Delay)
	}
}

func TestConcurrentModelFailuresCountOnce(t *testing.T) {
	a, prepared, _, host := newCredentialSyncFixture(t, false)
	a.store.Configure(t.TempDir())
	t.Cleanup(a.store.Flush)
	now := time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	attempt, err := a.beginModelAttempt(prepared)
	if err != nil {
		t.Fatal(err)
	}
	failure := &core.Failure{Kind: core.FailureKindHardCredit, Status: http.StatusTooManyRequests,
		Msg: "credits exhausted", RetryAfter: 3 * time.Hour}
	var workers sync.WaitGroup
	for range 12 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			reported := a.recordModelFailure(context.Background(), attempt, failure)
			if detail := streamErrorDetail(reported, streamFailureMessage(reported)); detail == nil ||
				detail.CredentialScoped || detail.RetryAfterSeconds != 3*3600 {
				t.Errorf("invalid stream error detail: %+v", detail)
			}
		}()
	}
	workers.Wait()
	first := a.store.ModelCooldown(attempt.fileID, attempt.model)
	if first.Failures != 1 || first.Delay != 3*time.Hour || host.saveCalls != 0 {
		t.Fatalf("concurrent failures advanced the cooldown: %+v", first)
	}
	now = first.RetryAt
	attempt, err = a.beginModelAttempt(prepared)
	if err != nil {
		t.Fatal(err)
	}
	a.recordModelFailure(context.Background(), attempt, failure)
	second := a.store.ModelCooldown(attempt.fileID, attempt.model)
	if second.Delay <= first.Delay {
		t.Fatalf("second cooldown %v must exceed first %v", second.Delay, first.Delay)
	}
	now = second.RetryAt
	attempt, err = a.beginModelAttempt(prepared)
	if err != nil {
		t.Fatal(err)
	}
	a.recordModelSuccess(attempt)
	if state := a.store.ModelCooldown(attempt.fileID, attempt.model); state.Failures != 0 || !state.Verified || !state.RetryAt.IsZero() {
		t.Fatalf("success did not reset the cooldown: %+v", state)
	}
}
