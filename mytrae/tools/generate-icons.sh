#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
for tool in rsvg-convert magick iconutil; do
	if ! command -v "$tool" >/dev/null; then
		echo "Missing $tool. On macOS install librsvg and imagemagick; iconutil ships with macOS." >&2
		exit 1
	fi
done
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/MyTrae.iconset"
rsvg-convert -w 1024 -h 1024 mytrae/branding/icon.svg > "$WORK/icon.png"
for size in 16 32 128 256 512; do
	magick "$WORK/icon.png" -resize "${size}x${size}" "$WORK/MyTrae.iconset/icon_${size}x${size}.png"
	double=$((size * 2))
	magick "$WORK/icon.png" -resize "${double}x${double}" "$WORK/MyTrae.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$WORK/MyTrae.iconset" -o resources/darwin/code.icns
magick "$WORK/icon.png" -resize 512x512 resources/linux/code.png
magick "$WORK/icon.png" -define icon:auto-resize=256,128,64,48,32,16 resources/win32/code.ico
for size in 70 150; do
	magick "$WORK/icon.png" -resize "${size}x${size}" "resources/win32/code_${size}x${size}.png"
done
for size in 192 512; do
	magick "$WORK/icon.png" -resize "${size}x${size}" "resources/server/code-${size}.png"
done
magick "$WORK/icon.png" -define icon:auto-resize=48,32,16 resources/server/favicon.ico
cp mytrae/branding/icon.svg src/vs/workbench/browser/media/code-icon.svg
echo 'MyTrae application icons generated.'
