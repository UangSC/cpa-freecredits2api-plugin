package admin

import (
	"net/url"
	"strconv"
	"testing"

	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/logger"
)

func TestLogsPagingUsesLastDeliveredSequence(t *testing.T) {
	logger.Error("test log cursor")
	_, before := logger.Snapshot(0, 1)
	for range 5 {
		logger.Error("test log backlog")
	}
	service := &Service{}
	req := pluginapi.ManagementRequest{Query: url.Values{"limit": {"2"}}}
	since := before
	for _, want := range []uint64{before + 2, before + 4, before + 5} {
		req.Query.Set("since", strconv.FormatUint(since, 10))
		payload := service.buildLogsPayload(req)
		entries := payload["entries"].([]logger.Entry)
		if payload["next"] != want || len(entries) == 0 || entries[0].Seq != since+1 {
			t.Fatalf("page since %d = %+v, next should be %d", since, payload, want)
		}
		since = want
	}
	req.Query.Set("since", strconv.FormatUint(since+10, 10))
	if payload := service.buildLogsPayload(req); payload["reset"] != true || payload["next"] != since {
		t.Fatalf("cursor from previous process should recover using the current log ring: %+v", payload)
	}
}
