#!/bin/sh
# install.sh — 把 dsh-tool-folder 装入 desktop profile（Windows 兜底方案）。
#
# 为什么不用 pnpm link：实测 pnpm 11.22 对 `link:` 依赖在 Windows 上会建出
# 空目录（2026-08-24），插件无法加载。兜底 = 直接拷贝内容到 profile 的
# node_modules（cordis 从那里按名解析插件），与 dsh-better-sidebar 等
# link 依赖等效。
#
# 用法：sh install.sh   （默认 desktop profile）
set -eu
PROFILE="${1:-desktop}"
SRC="E:/DSH-Data/dsh-tool-folder"
DST="E:/DSH-Data/.dsh/profiles/$PROFILE/node_modules/dsh-tool-folder"

rm -rf "$DST"
mkdir -p "$DST"
cp -r "$SRC/lib" "$SRC/package.json" "$SRC/cordis.patch.yml" "$DST/"

echo "已装入: $DST"
echo "确认 cordis.patch.yml 里有 tool-folder 的 insert 块（已含）。"
echo "然后重启 DSH，日志会输出 inject=x/y。"
