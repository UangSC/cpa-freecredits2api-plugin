package admin

// 本文件是凭证文件的唯一入口：
//   - saveAuthFile：通过宿主保存凭证；
//   - safeAuthFilePath：改写或删除前的全部校验。
//
// 宿主负责凭证目录与运行时注册。启用、停用及删除前须核对宿主记录对应的物理文件。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"cpa-tierbridge2api-plugin/internal/core"
	"cpa-tierbridge2api-plugin/internal/hostbridge"
	"cpa-tierbridge2api-plugin/internal/logger"
)

// removeAuthFile 会短暂等待 Windows 上的 CPA 文件监听器释放刚读过的凭证。
func removeAuthFile(path string) error {
	const sharingViolation = syscall.Errno(32)
	err := os.Remove(path)
	for _, wait := range []time.Duration{20 * time.Millisecond, 40 * time.Millisecond, 80 * time.Millisecond, 160 * time.Millisecond} {
		if runtime.GOOS != "windows" || !errors.Is(err, sharingViolation) {
			break
		}
		time.Sleep(wait)
		err = os.Remove(path)
	}
	return err
}

// saveAuthFile 由 CPA 落盘并登记账号，使用宿主实际的凭证目录。
func saveAuthFile(callbackID, fileName string, raw []byte) error {
	name := sanitizeAuthFileName(fileName)
	if name == "" || len(raw) == 0 {
		return fmt.Errorf("凭证缺少文件名或内容")
	}

	if _, errSave := hostbridge.SaveAuth(callbackID, name, raw); errSave != nil {
		logger.Debug("host.auth.save failed for %s: %v", name, errSave)
		return fmt.Errorf("CPA 未能保存凭证 %s", name)
	}
	logger.Info("saved auth file %s via host.auth.save", name)
	return nil
}

// sanitizeAuthFileName 把供应商给的凭证文件名收敛成一个安全的基名。
//
// 文件名一路从上游响应（登录流程）/账号昵称传到这里，早先是直接
// filepath.Join(dir, name) 落盘：带 `/` 或 `..` 的取值会把凭证写到目录外，
// 绝对路径更会直接忽略 dir。这里只保留基名、去掉控制字符与路径分隔符，
// 扩展名统一 .json；收敛后为空则拒绝写入。
func sanitizeAuthFileName(fileName string) string {
	name := strings.TrimSpace(fileName)
	if name == "" {
		return ""
	}
	// filepath.Base 在 Linux 上不认反斜杠，所以下面还要再替换一次。
	name = filepath.Base(name)
	name = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20, r == 0x7f:
			return -1
		case r == '/', r == '\\', r == ':', r == '*', r == '?', r == '"', r == '<', r == '>', r == '|':
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, ". ")
	if name == "" || name == "." || name == ".." {
		return ""
	}
	if !strings.EqualFold(filepath.Ext(name), ".json") {
		name += ".json"
	}
	return name
}

// safeAuthFilePath 校验一个凭证文件是否归本插件所有且可安全改写/删除，
// 返回绝对路径。
//
// 入参 path 必须已经是 hostbridge 归一化过的路径（ListAuths / AuthJSONAndPath
// 的出口都会做这件事）；这里不再换算，只校验——同一件事在两个层各做一次，
// 迟早会出现「有的调用点忘记归一化」的分歧。
//
// 四道检查的顺序是从「不值得尝试」到「必须实际落盘核对」：
//  1. 宿主给的凭证必须属于本插件；运行时凭证没有文件（RuntimeOnly / 路径为空）
//     → 直接拒绝；
//  2. 路径必须是绝对的；文件必须存在——**不存在不能当成功**：静默返回 nil 会让
//     页面显示「已删除」而账号其实还在；
//  3. 只认普通 `.json` 文件：符号链接、目录、别的扩展名一律拒绝；
//  4. 目标文件里的凭证必须与宿主给的凭证是同一个账号（vendor + UID）——路径
//     归一化用的是进程工作目录，基准不一致时同名文件可能属于另一个账号。
//     只比对身份字段，不读取或记录 token。
func safeAuthFilePath(registry *core.Registry, entry core.HostAuth, raw []byte, path string) (string, error) {
	hostCred, okHost := registry.ParseCredential(raw, hostbridge.AccountIdentity(entry), nil)
	if !okHost {
		return "", fmt.Errorf("该凭证不属于本插件，拒绝删除")
	}
	target := strings.TrimSpace(path)
	if entry.RuntimeOnly || target == "" {
		return "", fmt.Errorf("该账号没有对应的凭证文件（运行时凭证），无法删除")
	}
	if !filepath.IsAbs(target) {
		return "", fmt.Errorf("凭证路径未经宿主边界归一化：%s", target)
	}
	if !strings.HasSuffix(strings.ToLower(target), ".json") {
		return "", fmt.Errorf("拒绝删除非凭证文件：%s", filepath.Base(target))
	}
	info, errStat := os.Lstat(target)
	if errStat != nil {
		if os.IsNotExist(errStat) {
			return "", fmt.Errorf("凭证文件不存在，可能已被宿主移除：%s", filepath.Base(target))
		}
		return "", fmt.Errorf("检查文件失败：%w", errStat)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("拒绝删除符号链接：%s", filepath.Base(target))
	}
	if info.IsDir() {
		return "", fmt.Errorf("拒绝删除目录：%s", filepath.Base(target))
	}

	onDisk, errRead := os.ReadFile(target)
	if errRead != nil {
		return "", fmt.Errorf("读取凭证文件失败：%w", errRead)
	}
	fileCred, okFile := registry.ParseCredential(onDisk, strings.TrimSuffix(filepath.Base(target), ".json"), nil)
	if !okFile || !sameCredentialIdentity(hostCred, fileCred) {
		return "", fmt.Errorf("目标文件属于另一个账号，拒绝删除：%s", filepath.Base(target))
	}
	return target, nil
}

// sameCredentialIdentity 判断两份凭证是否指向同一个账号。
//
// vendor 或 UID 取不到时跳过该维度（部分供应商凭证里没有 UID）：宁可放行，
// 也不要卡住正常删除。只比对身份字段，不涉及 token。
func sameCredentialIdentity(hostCred, fileCred *core.Credential) bool {
	if hostVendor, fileVendor := hostCred.VendorIDValue(), fileCred.VendorIDValue(); hostVendor != "" && fileVendor != "" && hostVendor != fileVendor {
		return false
	}
	hostUID, fileUID := hostCred.UIDValue(), fileCred.UIDValue()
	return hostUID == "" || fileUID == "" || hostUID == fileUID
}

// setCredentialDisabled 在凭证 JSON 上设置/清除宿主的 disabled 标记。
//
// 宿主扫盘时只看凭证文件里的 "disabled" 字段（见 file synthesizer）：置 true
// 的凭证不再参与路由，删掉该字段即恢复。插件的启用/停用因此只能落在这个字段上，
// 没有第二条通道。
//
// 用 map[string]json.RawMessage 而不是 map[string]any：只增删一个键，其余字段
// 原样保留字节，float64 往返不会让超过 2^53 的整数（上游 uid）丢精度。
func setCredentialDisabled(raw []byte, disabled bool) ([]byte, error) {
	var payload map[string]json.RawMessage
	if errUnmarshal := json.Unmarshal(raw, &payload); errUnmarshal != nil || payload == nil {
		return nil, fmt.Errorf("凭证不是合法的 JSON 对象")
	}
	if disabled {
		payload["disabled"] = json.RawMessage("true")
	} else {
		delete(payload, "disabled")
	}
	updated, errMarshal := json.MarshalIndent(payload, "", "  ")
	if errMarshal != nil {
		return nil, errMarshal
	}
	return updated, nil
}
