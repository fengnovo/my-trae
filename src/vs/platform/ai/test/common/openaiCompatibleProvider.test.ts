/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	AIRequestPurpose,
	ILLMEndpoint,
	ILLMRequest,
	LLMFinishReason,
	LLMProviderKind,
	LLMRequestError,
} from '../../common/ai.js';
import { OpenAICompatibleProvider } from '../../common/openaiCompatibleProvider.js';
import { aggregateStream } from '../../common/streamAggregator.js';
import {
	dataFrame,
	drain,
	FakeTransport,
	newSignal,
	sseBody,
	textResponse,
} from './aiTestUtils.js';

const endpoint: ILLMEndpoint = {
	kind: LLMProviderKind.OpenAICompatible,
	baseUrl: 'https://api.example.com/v1',
	apiKey: 'sk-test',
	model: 'chat-model',
};

function chatRequest(overrides: Partial<ILLMRequest> = {}): ILLMRequest {
	return {
		messages: [{ role: 'user', content: 'hi' }],
		purpose: AIRequestPurpose.Chat,
		...overrides,
	};
}

function streamProvider(...frames: string[]): {
	provider: OpenAICompatibleProvider;
	transport: FakeTransport;
} {
	const transport = new FakeTransport(() => textResponse(sseBody(frames)));
	return { provider: new OpenAICompatibleProvider(transport), transport };
}

suite('AI OpenAICompatibleProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps a chat request onto the wire format', async () => {
		const { provider, transport } = streamProvider(dataFrame('[DONE]'));

		await drain(
			provider.streamChat(
				endpoint,
				chatRequest({
					messages: [
						{ role: 'system', content: 'be brief' },
						{ role: 'user', content: 'hi' },
					],
					temperature: 0.3,
					maxTokens: 256,
					stop: ['<|end|>'],
				}),
				newSignal(),
			),
		);

		assert.strictEqual(
			transport.lastRequest.url,
			'https://api.example.com/v1/chat/completions',
		);
		assert.strictEqual(
			transport.lastRequest.headers.Authorization,
			'Bearer sk-test',
		);
		assert.strictEqual(
			transport.lastRequest.headers.Accept,
			'text/event-stream',
		);

		const body = transport.lastBody;
		assert.strictEqual(body.model, 'chat-model');
		assert.strictEqual(body.stream, true);
		assert.deepStrictEqual(body.stream_options, { include_usage: true });
		assert.strictEqual(body.temperature, 0.3);
		assert.strictEqual(body.max_tokens, 256);
		assert.deepStrictEqual(body.stop, ['<|end|>']);
		assert.deepStrictEqual(body.messages, [
			{ role: 'system', content: 'be brief' },
			{ role: 'user', content: 'hi' },
		]);
	});

	test('lets the request override the endpoint model and strips a trailing slash', async () => {
		const { provider, transport } = streamProvider(dataFrame('[DONE]'));
		const trailing: ILLMEndpoint = {
			...endpoint,
			baseUrl: 'https://api.example.com/v1///',
		};

		await drain(
			provider.streamChat(
				trailing,
				chatRequest({ model: 'override-model' }),
				newSignal(),
			),
		);

		assert.strictEqual(
			transport.lastRequest.url,
			'https://api.example.com/v1/chat/completions',
		);
		assert.strictEqual(transport.lastBody.model, 'override-model');
	});

	test('declares tools as functions and enables automatic tool choice', async () => {
		const { provider, transport } = streamProvider(dataFrame('[DONE]'));

		await drain(
			provider.streamChat(
				endpoint,
				chatRequest({
					tools: [
						{
							name: 'read_file',
							description: 'Reads a file',
							parameters: { type: 'object' },
						},
					],
				}),
				newSignal(),
			),
		);

		const body = transport.lastBody;
		assert.strictEqual(body.tool_choice, 'auto');
		assert.deepStrictEqual(body.tools, [
			{
				type: 'function',
				function: {
					name: 'read_file',
					description: 'Reads a file',
					parameters: { type: 'object' },
				},
			},
		]);
	});

	test('omits optional fields that were not requested', async () => {
		const { provider, transport } = streamProvider(dataFrame('[DONE]'));

		await drain(provider.streamChat(endpoint, chatRequest(), newSignal()));

		const body = transport.lastBody;
		assert.strictEqual(body.temperature, undefined);
		assert.strictEqual(body.max_tokens, undefined);
		assert.strictEqual(body.tools, undefined);
		assert.strictEqual(body.stop, undefined);
	});

	test('streams text deltas, the finish reason and the usage', async () => {
		const { provider } = streamProvider(
			dataFrame('{"choices":[{"delta":{"content":"Hel"}}]}'),
			dataFrame('{"choices":[{"delta":{"content":"lo"}}]}'),
			dataFrame('{"choices":[{"delta":{},"finish_reason":"stop"}]}'),
			dataFrame('{"usage":{"prompt_tokens":5,"completion_tokens":2}}'),
			dataFrame('[DONE]'),
		);

		const chunks = await drain(
			provider.streamChat(endpoint, chatRequest(), newSignal()),
		);

		assert.deepStrictEqual(chunks, [
			{ textDelta: 'Hel' },
			{ textDelta: 'lo' },
			{ finishReason: LLMFinishReason.Stop },
			{ usage: { promptTokens: 5, completionTokens: 2 } },
		]);
	});

	test('keeps a text delta that arrives together with the finish reason', async () => {
		const { provider } = streamProvider(
			dataFrame(
				'{"choices":[{"delta":{"content":"done"},"finish_reason":"length"}]}',
			),
			dataFrame('[DONE]'),
		);

		const chunks = await drain(
			provider.streamChat(endpoint, chatRequest(), newSignal()),
		);

		assert.deepStrictEqual(chunks, [
			{ textDelta: 'done', finishReason: LLMFinishReason.Length },
		]);
	});

	test('ignores frames after the [DONE] sentinel', async () => {
		const { provider } = streamProvider(
			dataFrame('{"choices":[{"delta":{"content":"kept"}}]}'),
			dataFrame('[DONE]'),
			dataFrame('{"choices":[{"delta":{"content":"dropped"}}]}'),
		);

		const chunks = await drain(
			provider.streamChat(endpoint, chatRequest(), newSignal()),
		);

		assert.deepStrictEqual(chunks, [{ textDelta: 'kept' }]);
	});

	test('skips keep-alive frames that are not JSON', async () => {
		const { provider } = streamProvider(
			'data: \n\n',
			dataFrame('{"choices":[{"delta":{"content":"a"}}]}'),
			dataFrame('[DONE]'),
		);

		const chunks = await drain(
			provider.streamChat(endpoint, chatRequest(), newSignal()),
		);

		assert.deepStrictEqual(chunks, [{ textDelta: 'a' }]);
	});

	test('assembles streamed tool calls into one callable list', async () => {
		const { provider } = streamProvider(
			dataFrame(
				'{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}',
			),
			dataFrame(
				'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
			),
			dataFrame(
				'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}',
			),
			dataFrame('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
			dataFrame('[DONE]'),
		);

		const response = await aggregateStream(
			provider.streamChat(endpoint, chatRequest(), newSignal()),
		);

		assert.strictEqual(response.content, '');
		assert.strictEqual(response.finishReason, LLMFinishReason.ToolCalls);
		assert.deepStrictEqual(response.toolCalls, [
			{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
		]);
	});

	test('routes fill-in-the-middle completion to the legacy completions endpoint', async () => {
		const { provider, transport } = streamProvider(
			dataFrame('{"choices":[{"text":"return 1;"}]}'),
			dataFrame('{"choices":[{"text":"","finish_reason":"stop"}]}'),
			dataFrame('[DONE]'),
		);

		const chunks = await drain(
			provider.streamChat(
				endpoint,
				chatRequest({
					purpose: AIRequestPurpose.Completion,
					prefix: 'function answer() {\n',
					suffix: '\n}',
					maxTokens: 64,
				}),
				newSignal(),
			),
		);

		assert.strictEqual(
			transport.lastRequest.url,
			'https://api.example.com/v1/completions',
		);
		const body = transport.lastBody;
		assert.strictEqual(body.prompt, 'function answer() {\n');
		assert.strictEqual(body.suffix, '\n}');
		assert.strictEqual(body.max_tokens, 64);
		assert.strictEqual(body.temperature, 0);
		assert.strictEqual(body.messages, undefined);

		assert.deepStrictEqual(chunks, [
			{ textDelta: 'return 1;' },
			{ finishReason: LLMFinishReason.Stop },
		]);
	});

	test('chat purpose with a prefix still uses the chat endpoint', async () => {
		const { provider, transport } = streamProvider(dataFrame('[DONE]'));

		await drain(
			provider.streamChat(
				endpoint,
				chatRequest({ prefix: 'const a = ' }),
				newSignal(),
			),
		);

		assert.strictEqual(
			transport.lastRequest.url,
			'https://api.example.com/v1/chat/completions',
		);
	});

	test('turns a retryable HTTP failure into a retryable LLMRequestError', async () => {
		const transport = new FakeTransport(() =>
			textResponse('{"error":{"message":"rate limited"}}', 429),
		);
		const provider = new OpenAICompatibleProvider(transport);

		await assert.rejects(
			async () =>
				drain(provider.streamChat(endpoint, chatRequest(), newSignal())),
			(error: unknown) => {
				assert.ok(error instanceof LLMRequestError);
				assert.strictEqual(error.message, 'rate limited');
				assert.strictEqual(error.statusCode, 429);
				assert.strictEqual(error.retryable, true);
				assert.strictEqual(
					error.providerKind,
					LLMProviderKind.OpenAICompatible,
				);
				return true;
			},
		);
	});

	test('treats authentication failures as final', async () => {
		const transport = new FakeTransport(() =>
			textResponse('{"error":{"message":"bad key"}}', 401),
		);
		const provider = new OpenAICompatibleProvider(transport);

		await assert.rejects(
			async () =>
				drain(provider.streamChat(endpoint, chatRequest(), newSignal())),
			(error: unknown) => {
				assert.ok(error instanceof LLMRequestError);
				assert.strictEqual(error.retryable, false);
				return true;
			},
		);
	});

	test('falls back to the raw error body when it is not the usual envelope', async () => {
		const transport = new FakeTransport(() =>
			textResponse('gateway timeout', 504),
		);
		const provider = new OpenAICompatibleProvider(transport);

		await assert.rejects(
			async () =>
				drain(provider.streamChat(endpoint, chatRequest(), newSignal())),
			(error: unknown) => {
				assert.ok(error instanceof LLMRequestError);
				assert.strictEqual(error.message, 'gateway timeout');
				assert.strictEqual(error.retryable, true);
				return true;
			},
		);
	});

	test('requests and parses embeddings', async () => {
		const transport = new FakeTransport(() =>
			textResponse(
				JSON.stringify({
					data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
					model: 'embedding-model',
					usage: { prompt_tokens: 9 },
				}),
			),
		);
		const provider = new OpenAICompatibleProvider(transport);

		const response = await provider.embed(
			endpoint,
			{ input: ['a', 'b'], model: 'requested-model' },
			newSignal(),
		);

		assert.strictEqual(
			transport.lastRequest.url,
			'https://api.example.com/v1/embeddings',
		);
		assert.deepStrictEqual(transport.lastBody, {
			model: 'requested-model',
			input: ['a', 'b'],
		});
		assert.deepStrictEqual(response.embeddings, [
			[0.1, 0.2],
			[0.3, 0.4],
		]);
		assert.strictEqual(response.model, 'embedding-model');
		assert.deepStrictEqual(response.usage, { promptTokens: 9 });
	});

	test('serializes assistant tool calls and tool results back to the API', async () => {
		const { provider, transport } = streamProvider(dataFrame('[DONE]'));

		await drain(
			provider.streamChat(
				endpoint,
				chatRequest({
					messages: [
						{ role: 'user', content: 'read a.ts' },
						{
							role: 'assistant',
							content: '',
							toolCalls: [
								{
									id: 'call_1',
									name: 'read_file',
									arguments: '{"path":"a.ts"}',
								},
							],
						},
						{ role: 'tool', content: 'file body', toolCallId: 'call_1' },
					],
				}),
				newSignal(),
			),
		);

		assert.deepStrictEqual(transport.lastBody.messages, [
			{ role: 'user', content: 'read a.ts' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
					},
				],
			},
			{ role: 'tool', content: 'file body', tool_call_id: 'call_1' },
		]);
	});
});
