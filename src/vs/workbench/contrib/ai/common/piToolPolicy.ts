/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { PiAgentMode, PiToolName } from '../../../../platform/ai/common/piAgent.js';
import { localize } from '../../../../nls.js';

/** Resolve model-provided paths without accepting traversal or URI schemes. */
export function piWorkspaceResource(root: URI, path: string): URI {
	if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
		throw new Error(localize('pi.pathInvalid', "Invalid workspace path."));
	}
	const resource = path.startsWith('/') ? root.with({ path }) : joinPath(root, path);
	if (!isEqualOrParent(resource, root)) {
		throw new Error(localize('pi.pathOutside', "The path must stay inside the primary workspace folder."));
	}
	return resource;
}

/** Apply only a unique literal match, never a fuzzy or ambiguous edit. */
export function exactPiEdit(content: string, oldText: string, newText: string): string {
	const index = content.indexOf(oldText);
	if (!oldText || index < 0 || content.indexOf(oldText, index + 1) >= 0) {
		throw new Error(localize('pi.editAmbiguous', "oldText must match exactly once. Read the file again and supply a unique match."));
	}
	return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

/** Gate tools independently of the model prompt. Approval is additionally required at execution. */
export function assertPiToolAllowed(name: PiToolName, mode: PiAgentMode, trusted: boolean): void {
	if (!trusted) {
		throw new Error(localize('pi.untrusted', "Trust this workspace before using agent tools."));
	}
	if (mode !== 'build' && ['write_file', 'edit_file', 'run_terminal_command', 'remember'].includes(name)) {
		throw new Error(localize('pi.readOnly', "This tool requires Build mode and explicit approval."));
	}
}

/** Block non-web schemes, credential injection, and literal/special-use private targets. */
export function validatePiWebUrl(value: string): URL {
	const url = new URL(value);
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	const octets = host.split('.').map(Number);
	const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
	const privateIPv4 = isIPv4 && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127));
	// Reject all IPv6 literals: mapped, scoped and compressed private forms must not bypass IPv4 checks.
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host.includes(':') || privateIPv4 || !host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) || host === 'metadata.google.internal' || host === 'instance-data.ec2.internal') {
		throw new Error(localize('pi.webBlocked', "Only public HTTP(S) URLs without credentials are allowed."));
	}
	return url;
}
