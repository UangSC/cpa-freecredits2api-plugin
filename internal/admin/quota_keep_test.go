package admin

import (
	"errors"
	"testing"
)

// 刷新失败时保留上次读数。
//
// 上游限流（429）、超时、5xx 是常态：失败时把额度列清空，用户分不清
// 「没额度了」和「这次没取到」。保留上次读数并标非实时，比给空白更有信息量。

func TestKeepLastQuotaMarksStale(t *testing.T) {
	previous := &quotaResult{
		OK:        true,
		Remain:    2000,
		Total:     3000,
		Summary:   "剩余 2000/3000",
		FetchedAt: "2026-10-21T00:00:00Z",
	}

	kept, ok := keepLastQuota(previous, errors.New("upstream 429"))
	if !ok {
		t.Fatal("有上次成功读数时应保留")
	}
	if kept.Remain != 2000 || kept.Total != 3000 {
		t.Fatalf("读数被改动: remain=%d total=%d", kept.Remain, kept.Total)
	}
	if kept.Summary != "剩余 2000/3000" {
		t.Fatalf("摘要被改动: %q", kept.Summary)
	}
	if kept.FetchedAt != "2026-10-21T00:00:00Z" {
		t.Fatalf("应保留原始获取时间，实际 %q", kept.FetchedAt)
	}
	if !kept.Stale {
		t.Fatal("保留的读数必须标 Stale")
	}
	if kept.StaleReason != "upstream 429" {
		t.Fatalf("stale_reason = %q, 期望本次失败原因", kept.StaleReason)
	}
	// 原对象不能被污染：缓存里要保持「最后一次成功」的干净读数。
	if previous.Stale || previous.StaleReason != "" {
		t.Fatalf("不得修改缓存中的原对象，实际 stale=%v reason=%q", previous.Stale, previous.StaleReason)
	}
}

func TestKeepLastQuotaRejectsWithoutUsablePrevious(t *testing.T) {
	cases := []struct {
		name     string
		previous *quotaResult
		err      error
	}{
		{"没有上次读数", nil, errors.New("boom")},
		{"上次也是失败", &quotaResult{OK: false, Message: "401"}, errors.New("boom")},
		{"本次没有错误", &quotaResult{OK: true, Remain: 1}, nil},
	}
	for _, c := range cases {
		if _, ok := keepLastQuota(c.previous, c.err); ok {
			t.Fatalf("%s: 不该保留", c.name)
		}
	}
}

func TestQuotaCachedResultKeepsStaleReadingUntilNextSuccess(t *testing.T) {
	service := &Service{}
	service.cacheQuotaResult(quotaResult{OK: true, Remain: 100, UID: "u1", VendorID: "qodercn", AuthID: "a1"})

	kept, ok := keepLastQuota(service.getCachedQuota("qodercn", "u1", "a1"), errors.New("boom"))
	if !ok {
		t.Fatal("前置条件不成立：应能保留")
	}
	service.cacheQuotaResult(kept)
	cached := service.getCachedQuota("qodercn", "u1", "a1")
	if cached == nil || !cached.Stale || cached.Remain != 100 || cached.StaleReason != "boom" {
		t.Fatalf("过期读数和失败原因应对 /status 可见: %+v", cached)
	}
	service.cacheQuotaResult(quotaResult{OK: true, Remain: 90, UID: "u1", VendorID: "qodercn", AuthID: "a1"})
	cached = service.getCachedQuota("qodercn", "u1", "a1")
	if cached == nil || cached.Stale || cached.Remain != 90 || cached.StaleReason != "" {
		t.Fatalf("成功后应恢复实时读数: %+v", cached)
	}
}
