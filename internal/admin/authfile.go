package admin

// 本文件是凭证文件的唯一入口：
//   - saveAuthFile：通过宿主保存凭证；
//   - readAuthFile：改写或删除前校验归属并读取当前文件。
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

	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/hostbridge"
	"cpa-freecredits2api-plugin/internal/logger"
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

type authFileSnapshot struct {
	path        string
	raw         []byte
	vendorID    string
	tokensMatch bool
}

// readAuthFile 读取宿主确认的普通凭证文件，校验归属并带回磁盘上的最新内容。
// path 由 hostbridge 归一化为绝对路径。
func readAuthFile(registry *core.Registry, entry core.HostAuth, raw []byte, path string) (authFileSnapshot, error) {
	hostCred, okHost := registry.ParseCredential(raw, hostbridge.AccountIdentity(entry), nil)
	if !okHost {
		return authFileSnapshot{}, fmt.Errorf("该凭证不属于本插件")
	}
	target := strings.TrimSpace(path)
	if entry.RuntimeOnly || target == "" {
		return authFileSnapshot{}, fmt.Errorf("该账号没有对应的凭证文件（运行时凭证）")
	}
	if !filepath.IsAbs(target) {
		return authFileSnapshot{}, fmt.Errorf("凭证路径未经宿主边界归一化：%s", target)
	}
	if !strings.HasSuffix(strings.ToLower(target), ".json") {
		return authFileSnapshot{}, fmt.Errorf("目标不是 JSON 凭证文件：%s", filepath.Base(target))
	}
	info, errStat := os.Lstat(target)
	if errStat != nil {
		if os.IsNotExist(errStat) {
			return authFileSnapshot{}, fmt.Errorf("凭证文件不存在，可能已被宿主移除：%s", filepath.Base(target))
		}
		return authFileSnapshot{}, fmt.Errorf("检查文件失败：%w", errStat)
	}
	if !info.Mode().IsRegular() {
		return authFileSnapshot{}, fmt.Errorf("凭证路径必须指向普通文件：%s", filepath.Base(target))
	}

	onDisk, errRead := os.ReadFile(target)
	if errRead != nil {
		return authFileSnapshot{}, fmt.Errorf("读取凭证文件失败：%w", errRead)
	}
	fileCred, okFile := registry.ParseCredential(onDisk, strings.TrimSuffix(filepath.Base(target), ".json"), nil)
	if !okFile || !sameCredentialIdentity(hostCred, fileCred) {
		return authFileSnapshot{}, fmt.Errorf("目标文件属于另一个账号：%s", filepath.Base(target))
	}
	return authFileSnapshot{
		path: target, raw: onDisk, vendorID: fileCred.VendorIDValue(),
		tokensMatch: fileCred.TokenValue() == hostCred.TokenValue() && fileCred.RefreshTokenValue() == hostCred.RefreshTokenValue(),
	}, nil
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
