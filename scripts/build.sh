#!/usr/bin/env bash
# 构建插件动态库：先跑测试，再产出目标平台的 .so/.dll/.dylib。
#
# 默认使用 Docker 中的 Go 和 C 工具链构建 Linux glibc 动态库。
# 容器参数（镜像、挂载、GOCACHE 卷）全部收敛在 godocker.sh，本脚本只编排
# 「先 test 再 build」的顺序，避免两处各写一份 docker 命令。
#
# **不要用 alpine 版**：宿主 CPA 镜像是 Debian(glibc)，alpine(musl) 构建出的
# .so 会以 "libc.musl-aarch64.so.1: cannot open shared object file" 加载失败。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GODOCKER="$ROOT/scripts/godocker.sh"

# 产物名必须与 pluginID 一致（freetier2api）。
# 发行构建用 -s -w 减小产物体积。需要符号表或 DWARF 调试信息时，请构建不带这两个选项的版本。
LDFLAGS="-s -w"

mkdir -p "$ROOT/dist"

# 第一步：全量测试。
"$GODOCKER" test ./... -count=1 -timeout 300s

# 第二步：按目标平台决定扩展名。交叉构建需要容器中有对应的 C 工具链。
ext="so"
case "${GOOS:-linux}" in
  windows) ext="dll" ;;
  darwin) ext="dylib" ;;
esac

"$GODOCKER" build -buildmode=c-shared -ldflags="$LDFLAGS" -o "dist/freetier2api.$ext" .

echo "Built dist/freetier2api.$ext"
