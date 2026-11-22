package admin

import (
	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/logger"
)

func (s *Service) buildLogsPayload(req pluginapi.ManagementRequest) map[string]any {
	since := uint64(max(queryInt64(req.Query, "since", 0), 0))
	limit := int(queryInt64(req.Query, "limit", 200))
	entries, newest := logger.Snapshot(since, limit)
	reset := since > newest
	if reset {
		entries, newest = logger.Snapshot(0, limit)
	}
	// 增量页只推进到本次实际返回的序号，下一页才能拿到环中剩下的日志。
	next := newest
	if len(entries) != 0 {
		next = entries[len(entries)-1].Seq
	}
	return map[string]any{"ok": true, "entries": entries, "next": next, "reset": reset}
}
