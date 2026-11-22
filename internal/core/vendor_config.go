package core

import "sync/atomic"

// StringSetting 保存可在运行期间热更新的供应商配置。零值为空字符串。
type StringSetting struct {
	value atomic.Pointer[string]
}

func (s *StringSetting) Store(value string) { s.value.Store(&value) }

func (s *StringSetting) Load() string {
	if value := s.value.Load(); value != nil {
		return *value
	}
	return ""
}
