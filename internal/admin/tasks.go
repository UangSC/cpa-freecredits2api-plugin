package admin

// 本文件是任务引擎的管理接口适配层：解析请求、调用 tasks.Service、封装响应。

import (
	"net/http"

	"cpa-freecredits2api-plugin/cpasdk/pluginapi"
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/hostbridge"
	"cpa-freecredits2api-plugin/internal/tasks"
)

func (s *Service) handleTasksModules(_ pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	metas := s.tasks.ModuleMetas()
	if metas == nil {
		metas = []core.TaskModuleMeta{}
	}
	return JSONResponse(http.StatusOK, map[string]any{"ok": true, "modules": metas})
}

func (s *Service) handleTasksScan(req pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	options, errDecode := decodeRequest[tasks.ScanOptions](req.Body)
	if errDecode != nil {
		return BadJSONRequestResponse()
	}
	ctx, cancel := hostbridge.ManagementContext(req, requestTimeout)
	defer cancel()
	return JSONResponse(http.StatusOK, s.tasks.Scan(ctx, hostbridge.RequestCallbackID(req), options))
}

func (s *Service) handleTasksRun(req pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	// 缺省为并发 1，执行扫描得到的待办。保留旧版 growth / school 的请求字段。
	body, errDecode := decodeRequestInto(req.Body, tasks.DefaultQueueRequest())
	if errDecode != nil {
		return BadJSONRequestResponse()
	}
	ctx, cancel := hostbridge.ManagementContext(req, requestTimeout)
	defer cancel()
	payload, status := s.tasks.StartQueue(ctx, body, hostbridge.RequestCallbackID(req))
	return JSONResponse(status, payload)
}

func (s *Service) handleTasksQueue(_ pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	return JSONResponse(http.StatusOK, s.tasks.QueueSnapshot())
}

// taskAutoRequest 是「对单个账号执行单个任务」的请求体。
type taskAutoRequest struct {
	AuthID    string `json:"auth_id"`
	UID       string `json:"uid"`
	AccountID string `json:"account_id"`
	TaskCode  string `json:"task_code"`
	ModuleID  string `json:"module_id,omitempty"`
}

func (s *Service) handleTasksAuto(req pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	body, errDecode := decodeRequest[taskAutoRequest](req.Body)
	if errDecode != nil {
		return BadJSONRequestResponse()
	}
	ctx, cancel := hostbridge.ManagementContext(req, requestTimeout)
	defer cancel()
	identifier := core.FirstNonEmpty(body.AuthID, body.UID, body.AccountID)
	result, status := s.tasks.RunAutoModule(ctx, hostbridge.RequestCallbackID(req), identifier, body.TaskCode, body.ModuleID)
	return JSONResponse(status, result)
}

// handleTasksAutoAll 启动后台一键完成，立即返回任务编号。
//
// 一键完成要逐个账号串行跑，账号多时会超过管理请求的超时；同步执行的话
// 请求被取消、账号只跑了一半。改成后台任务后由页面轮询 /tasks/auto_all/status。
// 支持按 account_ids / vendor_ids / module_ids 隔离执行范围。
func (s *Service) handleTasksAutoAll(req pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	body, errDecode := decodeRequest[tasks.AutoAllOptions](req.Body)
	if errDecode != nil {
		return BadJSONRequestResponse()
	}
	payload, status := s.tasks.StartAutoAllFiltered(body)
	return JSONResponse(status, payload)
}

// handleTasksAutoAllStatus 返回后台一键完成的进度与结果。
func (s *Service) handleTasksAutoAllStatus(req pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	return JSONResponse(http.StatusOK, s.tasks.AutoAllStatus())
}

func (s *Service) handleSchoolStatus(req pluginapi.ManagementRequest) pluginapi.ManagementResponse {
	ctx, cancel := hostbridge.ManagementContext(req, requestTimeout)
	defer cancel()
	return JSONResponse(http.StatusOK, s.tasks.ActivityStatus(ctx, hostbridge.RequestCallbackID(req), "school"))
}
