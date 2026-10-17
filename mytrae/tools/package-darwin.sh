#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
	echo 'This package entry point requires macOS on Apple Silicon.' >&2
	exit 1
fi
if [[ $# -ne 0 ]]; then
	echo 'Usage: npm run mytrae:package:mac' >&2
	exit 1
fi

npm run gulp vscode-darwin-arm64
NAME="$(node -p "require('./product.json').nameLong")"
VERSION="$(node -p "require('./package.json').version")"
APP="$ROOT/../VSCode-darwin-arm64/$NAME.app"
bash mytrae/tools/resign-dev-app.sh "$APP"

mkdir -p dist
STAGE="$(mktemp -d "$ROOT/.build/mytrae-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"
DMG_NAME="MyTrae-${VERSION}-darwin-arm64.dmg"
DMG="$ROOT/dist/$DMG_NAME"
hdiutil create -volname MyTrae -srcfolder "$STAGE" -format UDZO -ov "$DMG"
hdiutil verify "$DMG"
(cd "$ROOT/dist" && shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256")
echo "Package: $DMG"
