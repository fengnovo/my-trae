/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AIChatContextKind, IAIChatContextItem } from '../../common/aiChat.js';
import {
	buildContextBlock,
	CHAT_SYSTEM_PROMPT,
	COMPLETION_SYSTEM_PROMPT,
	truncate,
} from '../../common/prompts.js';

function item(
	kind: AIChatContextKind,
	label: string,
	text?: string,
): IAIChatContextItem {
	return { kind, label, text };
}

suite('AI prompts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildContextBlock', () => {
		test('returns an empty string when nothing is attached', () => {
			assert.strictEqual(buildContextBlock([]), '');
		});

		test('wraps a single file in the workspace context envelope', () => {
			const block = buildContextBlock([
				item(AIChatContextKind.File, 'src/a.ts', 'const a = 1;'),
			]);
			assert.strictEqual(
				block,
				[
					'<workspace_context>',
					'<context kind="file" label="src/a.ts">',
					'const a = 1;',
					'</context>',
					'</workspace_context>',
				].join('\n'),
			);
		});

		test('names every context kind', () => {
			const block = buildContextBlock([
				item(AIChatContextKind.File, 'f', 'a'),
				item(AIChatContextKind.Selection, 's', 'b'),
				item(AIChatContextKind.Codebase, 'c', 'd'),
			]);
			assert.ok(block.includes('kind="file"'));
			assert.ok(block.includes('kind="selection"'));
			assert.ok(block.includes('kind="codebase"'));
		});

		test('escapes attribute breaking characters in the label', () => {
			const block = buildContextBlock([
				item(AIChatContextKind.File, 'a & b " c < d > e', 'x'),
			]);
			assert.ok(
				block.includes('label="a &amp; b &quot; c &lt; d &gt; e"'),
				block,
			);
		});

		test('skips items whose resolved text is empty', () => {
			const block = buildContextBlock([
				item(AIChatContextKind.File, 'empty.ts', ''),
				item(AIChatContextKind.File, 'missing.ts'),
				item(AIChatContextKind.File, 'real.ts', 'code'),
			]);
			assert.strictEqual((block.match(/<context /g) ?? []).length, 1);
			assert.ok(block.includes('label="real.ts"'));
			assert.ok(!block.includes('empty.ts'));
			assert.ok(!block.includes('missing.ts'));
		});

		test('collapses to an empty string when every item is empty', () => {
			assert.strictEqual(
				buildContextBlock([
					item(AIChatContextKind.File, 'a', ''),
					item(AIChatContextKind.Selection, 'b'),
				]),
				'',
			);
		});

		test('truncates an oversized attachment so one file cannot eat the window', () => {
			const block = buildContextBlock([
				item(AIChatContextKind.File, 'big.ts', 'x'.repeat(20000)),
			]);
			assert.match(block, /characters truncated/);
			assert.ok(
				block.length < 12000,
				`block should be capped, got ${block.length}`,
			);
		});
	});

	suite('truncate', () => {
		test('leaves text within the budget untouched', () => {
			assert.strictEqual(truncate('short', 100), 'short');
			assert.strictEqual(truncate('x'.repeat(100), 100), 'x'.repeat(100));
		});

		test('keeps a head and a tail and reports how much was dropped', () => {
			const long = `${'a'.repeat(70)}${'b'.repeat(55)}${'c'.repeat(25)}`; // 150 chars
			const out = truncate(long, 100);
			assert.ok(out.startsWith('a'.repeat(70)), 'head must be preserved');
			assert.ok(out.endsWith('c'.repeat(25)), 'tail must be preserved');
			assert.match(out, /55 characters truncated/);
			assert.ok(out.length < long.length);
		});
	});

	suite('system prompts', () => {
		test('the chat prompt identifies the assistant and its rules', () => {
			assert.match(CHAT_SYSTEM_PROMPT, /MyTrae/);
			assert.ok(CHAT_SYSTEM_PROMPT.includes('fenced block'));
		});

		test('the completion prompt forbids prose', () => {
			assert.ok(COMPLETION_SYSTEM_PROMPT.length > 0);
			assert.match(COMPLETION_SYSTEM_PROMPT, /completion/i);
		});
	});
});
