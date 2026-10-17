#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Refresh existing output too: upstream preLaunch only builds when out/ is absent.
node build/lib/preLaunch.ts
npm run build-fast
if [[ "$(uname -s)" == Darwin ]]; then
	bash mytrae/tools/resign-dev-app.sh
fi
unset ELECTRON_RUN_AS_NODE GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
export VSCODE_SKIP_PRELAUNCH=1
exec bash scripts/code.sh --disable-extension=GitHub.copilot-chat --disable-extension=GitHub.copilot "$@"
