/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Restores the repository convention for the MyTrae sources: NLS keys stay single-quoted while
 * the externalized message passed to `localize` / `localize2` must be double-quoted, otherwise the
 * NLS tooling and the `code-no-unexternalized-strings` rule can no longer recognise it.
 *
 * Editors that auto-format with a generic Prettier configuration tend to collapse every string to
 * single quotes; run this after such an accident:
 *
 * ```
 * node --experimental-strip-types mytrae/tools/restoreLocalizeQuotes.ts
 * ```
 */

import fs from "fs";
import path from "path";

const roots = ["src/vs/platform/ai", "src/vs/workbench/contrib/ai"];

/** `localize('key', 'message')` where the message was wrongly converted to single quotes. */
const messagePattern =
	/(\blocalize2?\(\s*)'((?:[^'\\]|\\.)*)'(\s*,\s*)'((?:[^'\\]|\\.)*)'/g;

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTypeScriptFiles(full, out);
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

let changedFiles = 0;
let changedMessages = 0;

for (const root of roots) {
	for (const file of collectTypeScriptFiles(root)) {
		const before = fs.readFileSync(file, "utf8");
		const after = before.replace(
			messagePattern,
			(
				_match,
				head: string,
				key: string,
				separator: string,
				message: string,
			) => {
				changedMessages++;
				return `${head}'${key}'${separator}"${message.replace(/\\"/g, '"')}"`;
			},
		);
		if (after !== before) {
			fs.writeFileSync(file, after);
			changedFiles++;
			console.log(`fixed ${file}`);
		}
	}
}

console.log(`rewrote ${changedMessages} message(s) in ${changedFiles} file(s)`);
