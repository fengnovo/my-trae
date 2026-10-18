/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { chunkSourceCode } from '../../common/codeChunker.js';

suite('CodeChunker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('splits brace languages at top-level declarations', () => {
		const source = [
			'import { x } from "y";',
			'export function one() {',
			'  const a = 1;',
			'  const b = 2;',
			'  const c = a + b;',
			'  return c;',
			'}',
			'export function two() {',
			'  const text = "{ not a brace";',
			'  const d = 4;',
			'  return d + 1;',
			'}',
		].join('\n');

		const chunks = chunkSourceCode(source, 'typescript');

		assert.deepStrictEqual(
			chunks.map(chunk => ({ startLine: chunk.startLine, endLine: chunk.endLine })),
			[{ startLine: 2, endLine: 7 }, { startLine: 8, endLine: 12 }],
		);
		assert.ok(chunks[0].text.includes('return c;'));
		assert.ok(chunks[1].text.includes('"{ not a brace"'));
		assert.ok(!chunks[0].text.includes('two'));
	});

	test('splits python on def and class boundaries', () => {
		const source = [
			'import os',
			'',
			'def first():',
			'    x = 1',
			'    return x',
			'',
			'class Second:',
			'    def method(self):',
			'        return 2',
			'',
			'def last():',
			'    return 3',
		].join('\n');

		const chunks = chunkSourceCode(source, 'python');

		assert.deepStrictEqual(
			chunks.map(chunk => ({ startLine: chunk.startLine, endLine: chunk.endLine })),
			[{ startLine: 1, endLine: 6 }, { startLine: 7, endLine: 12 }],
		);
		assert.ok(chunks[0].text.includes('def first'));
		assert.ok(chunks[1].text.includes('class Second:'));
		assert.ok(chunks[1].text.includes('def last():'));
	});

	test('keeps unstructured content as window chunks', () => {
		const source = Array.from({ length: 10 }, (_, index) => `plain line ${index + 1}`).join('\n');

		const chunks = chunkSourceCode(source, 'markdown');

		assert.deepStrictEqual(
			chunks.map(chunk => ({ startLine: chunk.startLine, endLine: chunk.endLine })),
			[{ startLine: 1, endLine: 10 }],
		);
	});

	test('windows oversized blocks with overlap', () => {
		const lines = ['export function big() {'];
		for (let i = 0; i < 200; i++) {
			lines.push(`  const value${i} = ${i};`);
		}
		lines.push('}');

		const chunks = chunkSourceCode(lines.join('\n'), 'typescript');

		assert.strictEqual(chunks.length, 3);
		assert.deepStrictEqual(chunks.map(chunk => chunk.startLine), [1, 83, 165]);
		assert.deepStrictEqual(chunks.map(chunk => chunk.endLine), [90, 172, 202]);
		for (const chunk of chunks) {
			assert.ok(chunk.endLine - chunk.startLine + 1 <= 90, 'window chunks stay within the line budget');
		}
		assert.ok(chunks[0].text.includes('export function big() {'));
	});
});
