#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------------
#
# Re-signs a local Electron app, including the Dev bundle in .build/electron, on Apple Silicon.
#
# Why this is needed:
#   gulp-electron renames Electron.app -> "<product.nameLong>.app" (and the main executable), which
#   invalidates the signature Apple shipped with Electron. A bare `codesign --force --deep --sign -`
#   reseals the bundle but drops every entitlement, so the moment V8 maps a JIT page the process
#   dies with `Received signal 11 SEGV_ACCERR`. This script signs every component inner-first with
#   the hardened runtime flag plus the permissive dev entitlements in dev-entitlements.plist.
#
# Usage:
#   bash mytrae/tools/resign-dev-app.sh
#   bash mytrae/tools/resign-dev-app.sh "/path/to/MyTrae - AI Code IDE.app"
#
# Re-run it after every `npm run electron` (i.e. whenever the bundle is rebuilt).
#---------------------------------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NAME="$(node -p "require('./product.json').nameLong")"
APP="${1:-.build/electron/${NAME}.app}"
FWKS="$APP/Contents/Frameworks"
ENT="$ROOT/mytrae/tools/dev-entitlements.plist"

if [[ ! -d "$APP" ]]; then
	echo "✗ App bundle not found: $APP" >&2
	echo "  Run 'node build/lib/preLaunch.ts' (or 'npm run electron') first." >&2
	exit 1
fi
if [[ ! -f "$ENT" ]]; then
	echo "✗ Entitlements plist not found: $ENT" >&2
	exit 1
fi

# Every component gets the hardened runtime flag; process-launching binaries also get entitlements.
SIGN_ENT=(codesign --force --options runtime --sign - --entitlements "$ENT")
SIGN_PLAIN=(codesign --force --options runtime --sign -)

echo ">> [1/5] Nested dylibs inside Electron Framework"
while IFS= read -r -d '' lib; do
	echo "   $lib"
	"${SIGN_PLAIN[@]}" "$lib"
done < <(find "$FWKS/Electron Framework.framework" -name '*.dylib' -print0 2>/dev/null)

echo ">> [2/5] chrome_crashpad_handler (a real process, needs entitlements)"
CRASHPAD="$FWKS/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler"
if [[ -e "$CRASHPAD" ]]; then
	"${SIGN_ENT[@]}" "$CRASHPAD"
fi

echo ">> [3/5] Frameworks"
while IFS= read -r -d '' fw; do
	echo "   $fw"
	"${SIGN_PLAIN[@]}" "$fw"
done < <(find "$FWKS" -maxdepth 1 -name '*.framework' -print0 2>/dev/null)

echo ">> [4/5] Helper apps (renderer/GPU/plugin all run V8 -> need allow-jit)"
while IFS= read -r -d '' helper; do
	echo "   $helper"
	"${SIGN_ENT[@]}" "$helper"
done < <(find "$FWKS" -maxdepth 1 -name '*.app' -print0 2>/dev/null)

echo ">> [5/5] Main app bundle"
"${SIGN_ENT[@]}" "$APP"

echo ">> Clearing quarantine attribute"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo ">> Verifying signature"
codesign --verify --strict --verbose=2 "$APP"

echo "✓ Re-signed: $APP"
