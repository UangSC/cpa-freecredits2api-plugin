// 本文件提供内嵌的控制台页面。
//
// 页面是纯静态单页 HTML（不含账号、额度或凭证），通过管理接口按需拉取数据；
// 渲染动态数据统一走 textContent，避免把上游内容当成 HTML 注入。
//
// 源码按职责拆分为 internal/admin/ui/ 下的独立 CSS / HTML / JS 模块，
// 在编译期通过 go:embed 零依赖拼装为单页输出，既保留「无前端构建工具链、
// 单文件分发」的轻量化优势，又避免数千行单文件难以维护的问题。

package admin

import (
	_ "embed"
	"encoding/base64"
	"html"
	"strings"
)

//go:embed ui/logo.svg
var uiLogoSVG string

//go:embed ui/styles.css
var uiStyles string

//go:embed ui/body.html
var uiBody string

//go:embed ui/core.js
var uiCoreJS string

//go:embed ui/accounts.js
var uiAccountsJS string

//go:embed ui/models.js
var uiModelsJS string

//go:embed ui/tasks.js
var uiTasksJS string

//go:embed ui/auth.js
var uiAuthJS string

//go:embed ui/settings_logs.js
var uiSettingsLogsJS string

var logoDataURI = "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(uiLogoSVG)))

// LogoDataURI 返回内嵌 SVG Logo 的 Data URI，供插件元数据和页面图标复用。
func LogoDataURI() string {
	return logoDataURI
}

var pageTemplate = strings.Join([]string{
	"<!DOCTYPE html>",
	"<html lang=\"zh-CN\">",
	"<head>",
	"<meta charset=\"utf-8\">",
	"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
	"<title>__PLUGIN_NAME__</title>",
	"<link rel=\"icon\" type=\"image/svg+xml\" href=\"__PLUGIN_FAVICON__\">",
	"<style>",
	uiStyles,
	"</style>",
	"</head>",
	"<body>",
	uiBody,
	"<script>",
	uiCoreJS,
	uiAccountsJS,
	uiModelsJS,
	uiTasksJS,
	uiAuthJS,
	uiSettingsLogsJS,
	"</script>",
	"</body>",
	"</html>",
	"",
}, "\n")

// Page 用宿主注册的插件身份渲染控制台标题和版本。
func Page(basePath string, id Identity) string {
	return strings.NewReplacer(
		"__BASE__", basePath,
		"__PLUGIN_NAME__", html.EscapeString(id.DisplayName),
		"__PLUGIN_VERSION__", html.EscapeString(id.Version),
		"__PLUGIN_FAVICON__", LogoDataURI(),
	).Replace(pageTemplate)
}
