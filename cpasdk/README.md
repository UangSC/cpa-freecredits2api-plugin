# cpasdk

本目录保留 CLIProxyAPI 宿主 ABI 和 JSON 契约的本地副本。C 结构体声明位于仓库根目录的 `cgo.go`。

- `pluginabi/types.go` 对齐宿主 `sdk/pluginabi/types.go`；
- `pluginapi/types.go` 保留插件所用的 API 类型。`ManagementRequest` 额外声明宿主 RPC 在 JSON 顶层传递的 `host_callback_id`，管理路由用它绑定宿主回调作用域。

同步时对照目标宿主版本的 SDK 和 RPC 请求结构，保留本仓库仍需使用的传输字段，并用真实宿主回归验证。CI 格式检查排除这份副本。宿主 ABI 源码见 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)。

本插件使用原生 ABI `1`、RPC schema `6` 和单一认证标识 `freecredits2api`。CPA v8.1.1 仍使用 ABI `1`，RPC schema 新增的多认证入口等能力可选。本插件只声明实际实现的能力。控制台资源和插件管理子路由沿用宿主的 `/v0` 挂载，宿主配置写入优先走 `/v8/management/config`。 [CPA v8.1.1 ABI](https://github.com/router-for-me/CLIProxyAPI/blob/v8.1.1/sdk/pluginabi/types.go) · [CPA v8.1.1 管理路由](https://github.com/router-for-me/CLIProxyAPI/blob/v8.1.1/internal/api/server_management_v8.go)

## 宿主请求缓冲区契约（`cliproxy_plugin_api.call` 的 `request`）

- 宿主侧约定：`request` / `request_len` 指向的内存在**本次同步调用期间**有效，且不会被并发改写；
  调用返回后插件不得再访问它。这条是宿主侧承诺（宿主源码不在本仓库）。
- 插件侧默认用 `C.GoBytes` 复制一份再处理。
- 例外：`response.normalize_before` 在根目录 `cgo.go` 的 `hostRequestBytes` +
  `isReadOnlyRequestMethod` 里直接借用宿主缓冲区（每个流式分片都会带着两份完整请求体，
  复制开销与请求大小成正比）。
- 因此进入该名单的方法必须满足：**只读**（不修改入参）、**不持有**（不保存任何切片片段）、
  **不异步**（不在调用返回后的 goroutine 里访问）。新增方法前先确认这三条。
