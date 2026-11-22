#!/usr/bin/env bash
# 在 Docker 容器中运行本项目的 Go 命令。
#
# 用 golang:1.24（Debian 版，自带 gcc，cgo 构建 c-shared 需要 C 编译器）。
#
# **不要用 alpine 版**：宿主 CPA 镜像是 Debian(glibc)，alpine(musl) 构建的
# .so 会以 "libc.musl-aarch64.so.1: cannot open shared object file" 加载失败。
#
# 用法：
#   ./scripts/godocker.sh test ./...        # go test ./...
#   ./scripts/godocker.sh build ./...       # go build ./...
#   ./scripts/godocker.sh vet ./...         # go vet ./...
#   ./scripts/godocker.sh run ./scripts/packstore ...  # go run
set -euo pipefail

IMAGE="golang:1.24"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# GOCACHE 使用 Docker 命名卷跨次复用，源码通过宿主目录挂载。
# GOOS/GOARCH 仅在显式设置时透传。CGO 交叉编译还需要匹配目标的 C 工具链。
CROSS=""
[ -n "${GOOS:-}" ] && CROSS="$CROSS -e GOOS=$GOOS"
[ -n "${GOARCH:-}" ] && CROSS="$CROSS -e GOARCH=$GOARCH"

exec docker run --rm \
  -v "$ROOT":/w \
  -v freecredits2api-gocache:/gocache \
  -w /w \
  -e GOCACHE=/gocache \
  -e CGO_ENABLED=1 \
  -e GOFLAGS=-buildvcs=false \
  $CROSS \
  "$IMAGE" go "$@"
