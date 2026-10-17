/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	AIRequestPurpose,
	ILLMRequest,
	LLMFinishReason,
	LLMProviderKind,
	LLMRequestError,
} from '../../common/ai.js';
import { AnthropicProvider } from '../../common/anthropicProvider.js';
import { aggregateStream } from '../../common/streamAggregator.js';
import {
	drain,
	FakeTransport,
	newSignal,
	sseBody,
	textResponse,
	typedFrame,
} from './aiTestUtils.js';

function request(overrides: Partial<ILLMRequest> = {}): ILLMRequest {
	return {
		messages: [{ role: 'user', content: 'hi' }],
		purpose: AIRequestPurpose.Chat,
		...overrides,
	};
}

function streamProvider(
	baseUrl: string,
	...frames: string[]
): { provider: AnthropicProvider; transport: FakeTransport } {
	const transport = new FakeTransport(() => textResponse(sseBody(frames)));
	return {
		provider: new AnthropicProvider(transport),
		transport,
	};
}

function endpointWith(baseUrl: string) {
	return {
		kind: LLMProviderKind.Anthropic,
		baseUrl,
		apiKey: 'sk-ant',
		model: 'claude-test',
	};
}

suite('AI AnthropicProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('appends the version segment when the base URL does not carry it', async () => {
		const { provider, transport } = streamProvider(
			'https://api.anthropic.com',
			typedFrame('message_stop', '{}'),
		);

		await drain(
			provider.streamChat(
				endpointWith('https://api.anthropic.com'),
				request(),
				newSignal(),
			),
		);
		assert.strictEqual(
			transport.lastRequest.url,
			'https://api.anthropic.com/v1/messages',
		);

		await drain(
			provider.streamChat(
				endpointWith('https://api.anthropic.com/v1/'),
				request(),
				newSignal(),
			),
		);
		assert.strictEqual(
			transport.lastRequest.url,
			'https://api.anthropic.com/v1/messages',
		);
	});

	test('sends the Anthropic specific headers', async () => {
		const { provider, transport } = streamProvider(
			'https://api.anthropic.com',
			typedFrame('message_stop', '{}'),
		);

		await drain(
			provider.streamChat(
				endpointWith('https://api.anthropic.com'),
				request(),
				newSignal(),
			),
		);

		const headers = transport.lastRequest.headers;
		assert.strictEqual(headers['x-api-key'], 'sk-ant');
		assert.strictEqual(headers['anthropic-version'], '2023-06-01');
		assert.strictEqual(
			headers['anthropic-dangerous-direct-browser-access'],
			'true',
		);
	});

	test('merges system messages into the system field', async () => {
		const { provider, transport } = streamProvider(
			'https://api.anthropic.com',
			typedFrame('message_stop', '{}'),
		);

		await drain(
			provider.streamChat(
				endpointWith('https://api.anthropic.com'),
				request({
					messages: [
						{ role: 'system', content: 'first rule' },
						{ role: 'system', content: '' },
						{ role: 'system', content: 'second rule' },
						{ role: 'user', content: 'hi' },
					],
					maxTokens: 128,
					temperature: 0.5,
					stop: ['STOP'],
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
		assert.strictEqual(body.system, 'first rule\n\nsecond rule');
		assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }]);
		assert.strictEqual(body.model, 'claude-test');
		assert.strictEqual(body.stream, true);
		assert.strictEqual(body.max_tokens, 128);
		assert.strictEqual(body.temperature, 0.5);
		assert.deepStrictEqual(body.stop_sequences, ['STOP']);
		assert.deepStrictEqual(body.tools, [
			{
				name: 'read_file',
				description: 'Reads a file',
				input_schema: { type: 'object' },
			},
		]);
	});

	test('defaults max_tokens because the API requires it', async () => {
		const { provider, transport } = streamProvider(
			'https://api.anthropic.com',
			typedFrame('message_stop', '{}'),
		);

		await drain(
			provider.streamChat(
				endpointWith('https://api.anthropic.com'),
				request(),
				newSignal(),
			),
		);

		assert.strictEqual(transport.lastBody.max_tokens, 4096);
		assert.strictEqual(transport.lastBody.system, undefined);
	});

	test('converts tool calls and tool results into content blocks', async () => {
		const { provider, transport } = streamProvider(
			'https://api.anthropic.com',
			typedFrame('message_stop', '{}'),
		);

		await drain(
			provider.streamChat(
				endpointWith('https://api.anthropic.com'),
				request({
					messages: [
						{ role: 'user', content: 'read a.ts' },
						{
							role: 'assistant',
							content: 'on it',
							toolCalls: [
								{
									id: 'toolu_1',
									name: 'read_file',
									arguments: '{"path":"a.ts"}',
								},
							],
						},
						{ role: 'tool', content: 'file body', toolCallId: 'toolu_1' },
						{
							role: 'assistant',
							content: '',
							toolCalls: [
								{ id: 'toolu_2', name: 'broken', arguments: '{"path":' },
							],
						},
					],
				}),
				newSignal(),
			),
		);

		assert.deepStrictEqual(transport.lastBody.messages, [
			{ role: 'user', content: 'read a.ts' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'on it' },
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'read_file',
						input: { path: 'a.ts' },
					},
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
				],
			},
			{
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_2',
						name: 'broken',
						input: { __invalidArguments: '{"path":' },
					},
				],
			},
		]);
	});

	test('maps the streaming events onto provider agnostic chunks', async () => {
		const { provider } = streamProvider(
			'https://api.anthropic.com',
			typedFrame('message_start', '{"message":{"usage":{"input_tokens":17}}}'),
			typedFrame(
				'content_block_start',
				'{"index":0,"content_block":{"type":"text","text":""}}',
			),
			typedFrame(
				'content_block_delta',
				'{"index":0,"delta":{"type":"text_delta","text":"Hel"}}',
			),
			typedFrame(
				'content_block_delta',
				'{"index":0,"delta":{"type":"text_delta","text":"lo"}}',
			),
			typedFrame('content_block_stop', '{"index":0}'),
			typedFrame(
				'content_block_start',
				'{"index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"grep"}}',
			),
			typedFrame(
				'content_block_delta',
				'{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":1}"}}',
			),
			typedFrame(
				'message_delta',
				'{"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
			),
			typedFrame('message_stop', '{}'),
			// Anything after message_stop must be ignored.
			typedFrame(
				'content_block_delta',
				'{"index":0,"delta":{"type":"text_delta","text":"late"}}',
			),
		);

		const chunks = await drain(
			provider.streamChat(
				endpointWith('https://api.anthropic.com'),
				request(),
				newSignal(),
			),
		);

		assert.deepStrictEqual(chunks, [
			{ usage: { promptTokens: 17 } },
			{ textDelta: 'Hel' },
			{ textDelta: 'lo' },
			{ toolCallDeltas: [{ index: 1, id: 'toolu_9', nameDelta: 'grep' }] },
			{ toolCallDeltas: [{ index: 1, argumentsDelta: '{"q":1}' }] },
			{
				finishReason: LLMFinishReason.ToolCalls,
				usage: { completionTokens: 8 },
			},
		]);
	});

	test('aggregates a streamed tool call into an executable description', async () => {
		const { provider } = streamProvider(
			'https://api.anthropic.com',
			typedFrame(
				'content_block_start',
				'{"index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}',
			),
			typedFrame(
				'content_block_delta',
				'{"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
			),
			typedFrame('message_delta', '{"delta":{"stop_reason":"tool_use"}}'),
			typedFrame('message_stop', '{}'),
		);

		const response = await aggregateStream(
			provider.streamChat(
				endpointWith('https://api.anthropic.com'),
				request(),
				newSignal(),
			),
		);

		assert.deepStrictEqual(response.toolCalls, [
			{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
		]);
		assert.strictEqual(response.finishReason, LLMFinishReason.ToolCalls);
	});

	test('maps the stop reasons', async () => {
		const cases: [string, LLMFinishReason][] = [
			['end_turn', LLMFinishReason.Stop],
			['stop_sequence', LLMFinishReason.Stop],
			['max_tokens', LLMFinishReason.Length],
			['refusal', LLMFinishReason.ContentFilter],
			['tool_use', LLMFinishReason.ToolCalls],
		];

		for (const [reason, expected] of cases) {
			const { provider } = streamProvider(
				'https://api.anthropic.com',
				typedFrame('message_delta', `{"delta":{"stop_reason":"${reason}"}}`),
				typedFrame('message_stop', '{}'),
			);
			const chunks = await drain(
				provider.streamChat(
					endpointWith('https://api.anthropic.com'),
					request(),
					newSignal(),
				),
			);
			assert.deepStrictEqual(
				chunks,
				[{ finishReason: expected }],
				`stop reason ${reason}`,
			);
		}
	});

	test('throws on an error event inside the stream', async () => {
		const { provider } = streamProvider(
			'https://api.anthropic.com',
			typedFrame(
				'content_block_delta',
				'{"index":0,"delta":{"type":"text_delta","text":"partial"}}',
			),
			typedFrame(
				'error',
				'{"error":{"type":"overloaded_error","message":"overloaded"}}',
			),
		);

		await assert.rejects(
			async () =>
				drain(
					provider.streamChat(
						endpointWith('https://api.anthropic.com'),
						request(),
						newSignal(),
					),
				),
			(error: unknown) => {
				assert.ok(error instanceof LLMRequestError);
				assert.strictEqual(error.message, 'overloaded');
				assert.strictEqual(error.providerKind, LLMProviderKind.Anthropic);
				return true;
			},
		);
	});

	test('classifies HTTP failures by status code', async () => {
		for (const [statusCode, retryable] of [
			[429, true],
			[529, true],
			[500, true],
			[400, false],
			[401, false],
		] as [number, boolean][]) {
			const transport = new FakeTransport(() =>
				textResponse(
					`{"error":{"type":"x","message":"failed ${statusCode}"}}`,
					statusCode,
				),
			);
			const provider = new AnthropicProvider(transport);

			await assert.rejects(
				async () =>
					drain(
						provider.streamChat(
							endpointWith('https://api.anthropic.com'),
							request(),
							newSignal(),
						),
					),
				(error: unknown) => {
					assert.ok(error instanceof LLMRequestError);
					assert.strictEqual(error.statusCode, statusCode);
					assert.strictEqual(error.retryable, retryable);
					assert.strictEqual(error.message, `failed ${statusCode}`);
					return true;
				},
			);
		}
	});

	test('rejects embeddings because the API does not offer them', async () => {
		const provider = new AnthropicProvider(
			new FakeTransport(() => textResponse('{}')),
		);

		await assert.rejects(
			async () =>
				provider.embed(
					endpointWith('https://api.anthropic.com'),
					{ input: ['a'] },
					newSignal(),
				),
			(error: unknown) => {
				assert.ok(error instanceof LLMRequestError);
				assert.strictEqual(error.retryable, false);
				assert.match(error.message, /embedding/i);
				return true;
			},
		);
	});
});
