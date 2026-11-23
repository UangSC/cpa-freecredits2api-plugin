package core

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// WithHTTPRateLimitHint 补充 HTTP 429 的标准等待提示，由 CPA 调度和持久化。
// 供应商可提前填入更准确的等待时间。没有有效提示时，让 CPA 使用原生退避。
func WithHTTPRateLimitHint(failure *Failure, response *http.Response) *Failure {
	if failure == nil || response == nil || response.StatusCode != http.StatusTooManyRequests ||
		failure.HTTPStatus() != http.StatusTooManyRequests || failure.RetryAfter > 0 {
		return failure
	}
	if wait := HTTPRetryAfter(response.Header, time.Now()); wait > 0 {
		withHint := *failure
		withHint.RetryAfter = wait
		return &withHint
	}
	return failure
}

// HTTPRetryAfter 解析标准 Retry-After 头，支持秒数和 HTTP 日期。
func HTTPRetryAfter(header http.Header, now time.Time) time.Duration {
	value := strings.TrimSpace(header.Get("Retry-After"))
	if seconds, err := strconv.ParseUint(value, 10, 64); err == nil && seconds <= uint64(math.MaxInt64)/uint64(time.Second) {
		return time.Duration(seconds) * time.Second
	}
	if deadline, err := http.ParseTime(value); err == nil && deadline.After(now) {
		return deadline.Sub(now)
	}
	return 0
}
