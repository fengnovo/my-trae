/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILLMStreamChunk, LLMFinishReason } from '../../common/ai.js';
import { aggregateStream } from '../../common/streamAggregator.js';

async function* fromArray(
	chunks: readonly ILLMStreamChunk[],
): AsyncIterable<ILLMStreamChunk> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

suite('AI streamAggregator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('concatenates text deltas in order', async () => {
		const response = await aggregateStream(
			fromArray([
				{ textDelta: 'Hello' },
				{ textDelta: ', ' },
				{ textDelta: 'world' },
				{ finishReason: LLMFinishReason.Stop },
			]),
		);

		assert.strictEqual(response.content, 'Hello, world');
		assert.strictEqual(response.finishReason, LLMFinishReason.Stop);
		assert.deepStrictEqual(response.toolCalls, []);
	});

	test('returns an empty result for an empty stream', async () => {
		const response = await aggregateStream(fromArray([]));

		assert.strictEqual(response.content, '');
		assert.strictEqual(response.finishReason, undefined);
		assert.strictEqual(response.usage, undefined);
	});

	test('reassembles streamed tool calls by index', async () => {
		const response = await aggregateStream(
			fromArray([
				{
					toolCallDeltas: [{ index: 0, id: 'call_1', nameDelta: 'read_file' }],
				},
				{ toolCallDeltas: [{ index: 0, argumentsDelta: '{"path":' }] },
				{ toolCallDeltas: [{ index: 0, argumentsDelta: '"a.ts"}' }] },
				{
					toolCallDeltas: [
						{ index: 1, id: 'call_2', nameDelta: 'grep' },
						{ index: 0, argumentsDelta: '' },
					],
				},
				{ finishReason: LLMFinishReason.ToolCalls },
			]),
		);

		assert.strictEqual(response.finishReason, LLMFinishReason.ToolCalls);
		assert.deepStrictEqual(response.toolCalls, [
			{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
			{ id: 'call_2', name: 'grep', arguments: '' },
		]);
	});

	test('sorts tool calls by index even when they arrive out of order', async () => {
		const response = await aggregateStream(
			fromArray([
				{ toolCallDeltas: [{ index: 2, id: 'c', nameDelta: 'third' }] },
				{ toolCallDeltas: [{ index: 0, id: 'a', nameDelta: 'first' }] },
			]),
		);

		assert.deepStrictEqual(
			response.toolCalls.map((call) => call.id),
			['a', 'c'],
		);
	});

	test('drops tool call entries without name and arguments', async () => {
		const response = await aggregateStream(
			fromArray([{ toolCallDeltas: [{ index: 0, id: 'call_1' }] }]),
		);

		assert.deepStrictEqual(response.toolCalls, []);
	});

	test('merges usage reported in separate chunks', async () => {
		const response = await aggregateStream(
			fromArray([
				{ usage: { promptTokens: 11 } },
				{ textDelta: 'x' },
				{ usage: { completionTokens: 7 } },
			]),
		);

		assert.deepStrictEqual(response.usage, {
			promptTokens: 11,
			completionTokens: 7,
		});
	});

	test('keeps the last reported finish reason', async () => {
		const response = await aggregateStream(
			fromArray([
				{ finishReason: LLMFinishReason.Length },
				{ finishReason: LLMFinishReason.Stop },
			]),
		);

		assert.strictEqual(response.finishReason, LLMFinishReason.Stop);
	});
});
