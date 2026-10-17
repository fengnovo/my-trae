/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IEmbeddingRequest,
	IEmbeddingResponse,
	ILLMEndpoint,
	ILLMMessage,
	ILLMProvider,
	ILLMRequest,
	ILLMStreamChunk,
	LLMFinishReason,
	LLMProviderKind,
	LLMRequestError,
} from './ai.js';
import { IAITransport } from './aiTransport.js';
import { readErrorResponse, sseEvents } from './sseStream.js';

/**
 * Provider for the Anthropic messages API. Kept separate from the OpenAI compatible
 * transport because the request envelope, the tool call representation and the SSE
 * event names all differ.
 */
export class AnthropicProvider implements ILLMProvider {
	readonly kind = LLMProviderKind.Anthropic;

	constructor(private readonly transport: IAITransport) {}

	async *streamChat(
		endpoint: ILLMEndpoint,
		request: ILLMRequest,
		token: AbortSignal,
	): AsyncIterable<ILLMStreamChunk> {
		const response = await this.transport.post(
			messagesUrl(endpoint.baseUrl),
			createHeaders(endpoint),
			JSON.stringify(this.createBody(endpoint, request)),
			token,
		);

		if (response.statusCode < 200 || response.statusCode >= 300) {
			throw await readErrorResponse(
				response,
				extractErrorMessage,
				toRequestError,
			);
		}

		for await (const event of sseEvents(response, token)) {
			if (event.type === 'message_stop') {
				return;
			}
			if (event.type === 'error') {
				throw toRequestError(
					extractErrorMessage(event.data) ?? 'Anthropic stream error',
					undefined,
				);
			}

			const chunk = parseEvent(event.type, event.data);
			if (chunk) {
				yield chunk;
			}
		}
	}

	async embed(
		_endpoint: ILLMEndpoint,
		_request: IEmbeddingRequest,
		_token: AbortSignal,
	): Promise<IEmbeddingResponse> {
		// Anthropic has no embeddings API. Indexing must be pointed at an OpenAI
		// compatible embedding endpoint, which the settings expose separately.
		throw new LLMRequestError(
			'The Anthropic provider does not offer embeddings. Configure an OpenAI compatible embedding endpoint for codebase indexing.',
			undefined,
			false,
			LLMProviderKind.Anthropic,
		);
	}

	private createBody(
		endpoint: ILLMEndpoint,
		request: ILLMRequest,
	): IAnthropicRequestBody {
		const system = request.messages
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.filter((content) => content.length > 0)
			.join('\n\n');

		const body: IAnthropicRequestBody = {
			model: request.model ?? endpoint.model,
			max_tokens: request.maxTokens ?? 4096,
			stream: true,
			messages: request.messages
				.filter((message) => message.role !== 'system')
				.map(toAnthropicMessage),
		};

		if (system.length > 0) {
			body.system = system;
		}
		if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}
		if (request.stop && request.stop.length > 0) {
			body.stop_sequences = [...request.stop];
		}
		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters,
			}));
		}
		return body;
	}
}

/**
 * Maps our provider agnostic chunk onto an Anthropic SSE event. Block indices from the
 * API are reused as tool call indices so that deltas of the same call stay together.
 */
function parseEvent(type: string, data: string): ILLMStreamChunk | undefined {
	const json = tryParse(data);
	if (!json) {
		return undefined;
	}

	switch (type) {
		case 'content_block_start': {
			const block = json.content_block;
			if (block?.type === 'tool_use') {
				return {
					toolCallDeltas: [
						{
							index: json.index ?? 0,
							id: block.id,
							nameDelta: block.name,
						},
					],
				};
			}
			return undefined;
		}
		case 'content_block_delta': {
			const delta = json.delta;
			if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
				return { textDelta: delta.text };
			}
			if (
				delta?.type === 'input_json_delta' &&
				typeof delta.partial_json === 'string'
			) {
				return {
					toolCallDeltas: [
						{ index: json.index ?? 0, argumentsDelta: delta.partial_json },
					],
				};
			}
			return undefined;
		}
		case 'message_delta': {
			const chunk: {
				finishReason?: LLMFinishReason;
				usage?: { completionTokens?: number };
			} = {};
			if (json.delta?.stop_reason) {
				chunk.finishReason = toFinishReason(json.delta.stop_reason);
			}
			if (json.usage?.output_tokens !== undefined) {
				chunk.usage = { completionTokens: json.usage.output_tokens };
			}
			return Object.keys(chunk).length > 0 ? chunk : undefined;
		}
		case 'message_start': {
			const usage = json.message?.usage;
			return usage?.input_tokens !== undefined
				? { usage: { promptTokens: usage.input_tokens } }
				: undefined;
		}
		default:
			// ping, content_block_stop and unknown events carry no payload for us.
			return undefined;
	}
}

function toFinishReason(reason: string): LLMFinishReason {
	switch (reason) {
		case 'tool_use':
			return LLMFinishReason.ToolCalls;
		case 'max_tokens':
			return LLMFinishReason.Length;
		case 'refusal':
			return LLMFinishReason.ContentFilter;
		default:
			return LLMFinishReason.Stop;
	}
}

/**
 * Converts a chat message into Anthropic content blocks. Tool results become a
 * `tool_result` block inside a user message, and assistant tool calls become
 * `tool_use` blocks, matching what the API expects on the next turn.
 */
function toAnthropicMessage(message: ILLMMessage): IAnthropicMessage {
	if (message.role === 'tool') {
		return {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: message.toolCallId ?? '',
					content: message.content,
				},
			],
		};
	}

	if (
		message.role === 'assistant' &&
		message.toolCalls &&
		message.toolCalls.length > 0
	) {
		const content: IAnthropicContentBlock[] = [];
		if (message.content.length > 0) {
			content.push({ type: 'text', text: message.content });
		}
		for (const call of message.toolCalls) {
			content.push({
				type: 'tool_use',
				id: call.id,
				name: call.name,
				input: parseArguments(call.arguments),
			});
		}
		return { role: 'assistant', content };
	}

	return {
		role: message.role === 'assistant' ? 'assistant' : 'user',
		content: message.content,
	};
}

function parseArguments(raw: string): unknown {
	if (raw.length === 0) {
		return {};
	}
	try {
		return JSON.parse(raw);
	} catch {
		// Models occasionally emit truncated JSON; pass the raw text so the tool can
		// report a meaningful validation error instead of crashing the loop.
		return { __invalidArguments: raw };
	}
}

function messagesUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, '');
	return trimmed.endsWith('/v1')
		? `${trimmed}/messages`
		: `${trimmed}/v1/messages`;
}

function createHeaders(endpoint: ILLMEndpoint): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		Accept: 'text/event-stream',
		'x-api-key': endpoint.apiKey,
		'anthropic-version': '2023-06-01',
		'anthropic-dangerous-direct-browser-access': 'true',
	};
}

function toRequestError(
	message: string,
	statusCode: number | undefined,
): LLMRequestError {
	const retryable =
		statusCode === 429 ||
		statusCode === 529 ||
		(statusCode !== undefined && statusCode >= 500);
	return new LLMRequestError(
		message,
		statusCode,
		retryable,
		LLMProviderKind.Anthropic,
	);
}

/** Anthropic error envelope: `{ "error": { "type": ..., "message": ... } }`. */
function extractErrorMessage(body: string): string | undefined {
	return tryParse(body)?.error?.message;
}

function tryParse(data: string): IAnthropicEventJson | undefined {
	try {
		return JSON.parse(data) as IAnthropicEventJson;
	} catch {
		return undefined;
	}
}

// --- Wire format types ---

interface IAnthropicRequestBody {
	model: string;
	max_tokens: number;
	stream: boolean;
	messages: IAnthropicMessage[];
	system?: string;
	temperature?: number;
	stop_sequences?: string[];
	tools?: { name: string; description: string; input_schema: unknown }[];
}

type IAnthropicContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: 'tool_result'; tool_use_id: string; content: string };

interface IAnthropicMessage {
	role: 'user' | 'assistant';
	content: string | IAnthropicContentBlock[];
}

interface IAnthropicEventJson {
	index?: number;
	content_block?: { type?: string; id?: string; name?: string };
	delta?: {
		type?: string;
		text?: string;
		partial_json?: string;
		stop_reason?: string;
	};
	usage?: { input_tokens?: number; output_tokens?: number };
	message?: { usage?: { input_tokens?: number } };
	error?: { type?: string; message?: string };
}
