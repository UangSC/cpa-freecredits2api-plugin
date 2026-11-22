package app

// 本文件是唯一的供应商组合根：新增/删除供应商只改这里的工厂列表。

import (
	"cpa-freecredits2api-plugin/internal/core"
	"cpa-freecredits2api-plugin/internal/vendors/autoclaw"
	"cpa-freecredits2api-plugin/internal/vendors/cline"
	"cpa-freecredits2api-plugin/internal/vendors/codearts"
	"cpa-freecredits2api-plugin/internal/vendors/minimaxcode"
	"cpa-freecredits2api-plugin/internal/vendors/opencodezen"
	"cpa-freecredits2api-plugin/internal/vendors/qoder"
	"cpa-freecredits2api-plugin/internal/vendors/qwenwork"
	"cpa-freecredits2api-plugin/internal/vendors/raccoon"
	"cpa-freecredits2api-plugin/internal/vendors/tokenplan"
	"cpa-freecredits2api-plugin/internal/vendors/trae"
	"cpa-freecredits2api-plugin/internal/vendors/workbuddy"
	"cpa-freecredits2api-plugin/internal/vendors/zcode"
)

// BuiltinFactories 返回内置供应商工厂（顺序即注册顺序）。
func BuiltinFactories() []core.VendorFactory {
	return []core.VendorFactory{
		{Instances: autoclaw.Instances},
		{Instances: func(env core.Env) []core.Vendor { return cline.Instances(env) }},
		{Instances: codearts.Instances},
		{Instances: minimaxcode.Instances},
		{Instances: func(env core.Env) []core.Vendor { return opencodezen.Instances(env) }},
		{Instances: qoder.Instances},
		{Instances: qwenwork.Instances},
		{Instances: raccoon.Instances},
		{Instances: trae.Instances},
		{Instances: tokenplan.Instances},
		{Instances: workbuddy.Instances},
		{Instances: zcode.Instances},
	}
}
