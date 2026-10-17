/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AIChatContextKind, IAIChatContextItem } from './aiChat.js';

/**
 * Prompt templates and context serialization. Kept in `common` so that the chat panel,
 * inline completion and the agent all describe the workspace the same way to the model.
 */

export const CHAT_SYSTEM_PROMPT = [
	'You are MyTrae, an AI pair programmer embedded in a desktop code editor.',
	'',
	'Rules:',
	'- Answer in the language the user writes in.',
	'- Be concise. Skip preamble and do not restate the question.',
	'- Put every piece of code in a fenced block tagged with its language.',
	'- When editing existing code, show the smallest useful excerpt and mark unchanged regions with `// ... existing code ...`.',
	'- State the file path above a code block when the answer touches a specific file.',
	'- Never invent APIs, file paths or dependency versions. If the provided context is insufficient, say what is missing.',
	'- Prefer standard library and existing project dependencies over new ones.',
].join('\n');

export const COMPLETION_SYSTEM_PROMPT =
	'You are a code completion engine. Continue the code exactly where it stopped. Output only the continuation: no explanation, no markdown fences, no repetition of the prefix.';

/** Hard cap for one attached file so a single reference cannot blow the context window. */
const MAX_CONTEXT_ITEM_CHARS = 12000;

/**
 * Serializes attached context into one XML-ish block. Tagged sections keep the model
 * able to tell file contents apart from the user question, which plain concatenation
 * does not.
 */
export function buildContextBlock(
	items: readonly IAIChatContextItem[],
): string {
	if (items.length === 0) {
		return '';
	}

	const parts: string[] = ['<workspace_context>'];
	for (const item of items) {
		const text = truncate(item.text ?? '', MAX_CONTEXT_ITEM_CHARS);
		if (text.length === 0) {
			continue;
		}
		parts.push(
			`<context kind="${contextKindName(item.kind)}" label="${escapeAttribute(item.label)}">`,
		);
		parts.push(text);
		parts.push('</context>');
	}
	parts.push('</workspace_context>');

	// Only the wrapper tags are left when every item was empty.
	return parts.length > 2 ? parts.join('\n') : '';
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const head = text.slice(0, Math.floor(maxChars * 0.7));
	const tail = text.slice(text.length - Math.floor(maxChars * 0.25));
	return `${head}\n/* ... ${text.length - head.length - tail.length} characters truncated ... */\n${tail}`;
}

function contextKindName(kind: AIChatContextKind): string {
	switch (kind) {
		case AIChatContextKind.File:
			return 'file';
		case AIChatContextKind.Selection:
			return 'selection';
		default:
			return 'codebase';
	}
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
