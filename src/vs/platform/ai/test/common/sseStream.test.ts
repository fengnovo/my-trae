/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ISSEEvent } from '../../../../base/common/sseParser.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { LLMRequestError, LLMProviderKind } from '../../common/ai.js';
import { readErrorResponse, sseEvents } from '../../common/sseStream.js';
import {
	chunkedResponse,
	dataFrame,
	drain,
	newSignal,
	sseBody,
	textResponse,
	typedFrame,
} from './aiTestUtils.js';

const encoder = new TextEncoder();

suite('AI sseStream', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('emits one event per frame', async () => {
		const response = textResponse(
			sseBody([dataFrame('first'), dataFrame('second')]),
		);

		const events = await drain(sseEvents(response, newSignal()));

		assert.deepStrictEqual(
			events.map((event) => event.data),
			['first', 'second'],
		);
		assert.strictEqual(
			events.every((event) => event.type === 'message'),
			true,
		);
	});

	test('keeps the event type of a named frame', async () => {
		const response = textResponse(
			sseBody([typedFrame('content_block_delta', '{}')]),
		);

		const [event] = await drain(sseEvents(response, newSignal()));

		assert.strictEqual(event.type, 'content_block_delta');
		assert.strictEqual(event.data, '{}');
	});

	test('reassembles a frame split across chunk boundaries', async () => {
		const frame = dataFrame('{"text":"streamed"}');
		const bytes = encoder.encode(frame);
		const response = chunkedResponse([
			bytes.subarray(0, 9),
			bytes.subarray(9, 20),
			bytes.subarray(20),
		]);

		const events = await drain(sseEvents(response, newSignal()));

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].data, '{"text":"streamed"}');
	});

	test('decodes a multi-byte character split between two chunks', async () => {
		const bytes = encoder.encode(dataFrame('héllo'));
		// 0xC3 is the lead byte of the UTF-8 sequence for "é".
		const leadIndex = bytes.indexOf(0xc3);
		assert.notStrictEqual(leadIndex, -1);
		const response = chunkedResponse([
			bytes.subarray(0, leadIndex + 1),
			bytes.subarray(leadIndex + 1),
		]);

		const events = await drain(sseEvents(response, newSignal()));

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].data, 'héllo');
	});

	test('stops delivering events once the signal is aborted', async () => {
		const controller = new AbortController();
		const response = textResponse(
			sseBody([dataFrame('one'), dataFrame('two'), dataFrame('three')]),
		);

		const seen: ISSEEvent[] = [];
		for await (const event of sseEvents(response, controller.signal)) {
			seen.push(event);
			controller.abort();
		}

		assert.deepStrictEqual(
			seen.map((event) => event.data),
			['one'],
		);
	});

	test('returns immediately for an already aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();
		const response = textResponse(sseBody([dataFrame('one')]));

		const events = await drain(sseEvents(response, controller.signal));

		assert.deepStrictEqual(events, []);
	});

	test('propagates a transport failure to the consumer', async () => {
		const failure = new Error('connection reset');
		const response = {
			statusCode: 200,
			headers: {},
			chunks: (async function* (): AsyncIterable<Uint8Array> {
				yield encoder.encode(dataFrame('one'));
				throw failure;
			})(),
		};

		const events: ISSEEvent[] = [];
		await assert.rejects(async () => {
			for await (const event of sseEvents(response, newSignal())) {
				events.push(event);
			}
		}, /connection reset/);
		assert.strictEqual(events.length, 1);
	});

	test('readErrorResponse prefers the extracted message', async () => {
		const response = textResponse(
			'{"error":{"message":"quota exceeded"}}',
			429,
		);

		const error = await readErrorResponse(
			response,
			(body) =>
				(JSON.parse(body) as { error: { message: string } }).error.message,
			(message, statusCode) =>
				new LLMRequestError(
					message,
					statusCode,
					true,
					LLMProviderKind.OpenAICompatible,
				),
		);

		assert.ok(error instanceof LLMRequestError);
		assert.strictEqual(error.message, 'quota exceeded');
		assert.strictEqual(error.statusCode, 429);
		assert.strictEqual(error.retryable, true);
	});

	test('readErrorResponse falls back to the raw body', async () => {
		const response = textResponse('  upstream exploded \n', 502);

		const error = await readErrorResponse(
			response,
			() => undefined,
			(message, statusCode) =>
				new LLMRequestError(
					message,
					statusCode,
					false,
					LLMProviderKind.Anthropic,
				),
		);

		assert.ok(error instanceof LLMRequestError);
		assert.strictEqual(error.message, 'upstream exploded');
		assert.strictEqual(error.statusCode, 502);
	});
});
