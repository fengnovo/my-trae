/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AIRequestPurpose,
	IEmbeddingRequest,
	IEmbeddingResponse,
	ILLMEndpoint,
	ILLMMessage,
	ILLMProvider,
	ILLMRequest,
	ILLMStreamChunk,
	ILLMToolCallDelta,
	LLMFinishReason,
	LLMProviderKind,
	LLMRequestError,
} from './ai.js';
import { IAITransport, readResponseText } from './aiTransport.js';
import { readErrorResponse, sseEvents } from './sseStream.js';

/**
 * Provider for the OpenAI chat completions wire format. Covers OpenAI itself plus every
 * OpenAI compatible gateway (DeepSeek, Qwen/DashScope, Moonshot, Zhipu, vLLM, Ollama,
 * LM Studio, ...), which is why it is the default transport of this product.
 */
export class OpenAICompatibleProvider implements ILLMProvider {
	readonly kind = LLMProviderKind.OpenAICompatible;

	constructor(private readonly transport: IAITransport) {}

	async *streamChat(
		endpoint: ILLMEndpoint,
		request: ILLMRequest,
		token: AbortSignal,
	): AsyncIterable<ILLMStreamChunk> {
		const isFim =
			request.purpose === AIRequestPurpose.Completion &&
			request.prefix !== undefined;
		const url = joinUrl(
			endpoint.baseUrl,
			isFim ? 'completions' : 'chat/completions',
		);
		const body = isFim
			? this.createFimBody(endpoint, request)
			: this.createChatBody(endpoint, request);

		const response = await this.transport.post(
			url,
			createHeaders(endpoint),
			JSON.stringify(body),
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
			if (event.data === SSE_DONE) {
				return;
			}
			const chunk = this.parseChunk(event.data);
			if (chunk) {
				yield chunk;
			}
		}
	}

	async embed(
		endpoint: ILLMEndpoint,
		request: IEmbeddingRequest,
		token: AbortSignal,
	): Promise<IEmbeddingResponse> {
		const url = joinUrl(endpoint.baseUrl, 'embeddings');
		const response = await this.transport.post(
			url,
			createHeaders(endpoint),
			JSON.stringify({
				model: request.model ?? endpoint.model,
				input: request.input,
			}),
			token,
		);

		if (response.statusCode < 200 || response.statusCode >= 300) {
			throw await readErrorResponse(
				response,
				extractErrorMessage,
				toRequestError,
			);
		}

		const text = await readResponseText(response);
		const json = JSON.parse(text) as IOpenAIEmbeddingResponse;
		return {
			embeddings: json.data.map((entry) => entry.embedding),
			model: json.model ?? request.model ?? endpoint.model,
			usage: json.usage
				? { promptTokens: json.usage.prompt_tokens }
				: undefined,
		};
	}

	private createChatBody(
		endpoint: ILLMEndpoint,
		request: ILLMRequest,
	): IOpenAIChatRequestBody {
		const body: IOpenAIChatRequestBody = {
			model: request.model ?? endpoint.model,
			messages: request.messages.map(toOpenAIMessage),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}
		if (request.maxTokens !== undefined) {
			body.max_tokens = request.maxTokens;
		}
		if (request.stop && request.stop.length > 0) {
			body.stop = [...request.stop];
		}
		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools.map((tool) => ({
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				},
			}));
			body.tool_choice = 'auto';
		}
		return body;
	}

	/**
	 * Fill-in-the-middle completion. Falls back to the legacy completions endpoint which
	 * is what DeepSeek, Qwen-coder and StarCoder style models expose for FIM.
	 */
	private createFimBody(
		endpoint: ILLMEndpoint,
		request: ILLMRequest,
	): Record<string, unknown> {
		return {
			model: request.model ?? endpoint.model,
			prompt: request.prefix ?? '',
			suffix: request.suffix ?? '',
			stream: true,
			max_tokens: request.maxTokens ?? 512,
			temperature: request.temperature ?? 0,
		};
	}

	private parseChunk(data: string): ILLMStreamChunk | undefined {
		let json: IOpenAIStreamChunkJson;
		try {
			json = JSON.parse(data) as IOpenAIStreamChunkJson;
		} catch {
			// Some gateways emit keep-alive comments or non-JSON payloads; skip them.
			return undefined;
		}

		if (json.usage) {
			return {
				usage: {
					promptTokens: json.usage.prompt_tokens,
					completionTokens: json.usage.completion_tokens,
				},
			};
		}

		const choice = json.choices?.[0];
		if (!choice) {
			return undefined;
		}

		const delta = choice.delta;
		let textDelta: string | undefined;
		let toolCallDeltas: ILLMToolCallDelta[] | undefined;

		if (delta?.tool_calls && delta.tool_calls.length > 0) {
			toolCallDeltas = delta.tool_calls.map((call) => ({
				index: call.index ?? 0,
				id: call.id,
				nameDelta: call.function?.name,
				argumentsDelta: call.function?.arguments,
			}));
		} else if (delta?.content) {
			textDelta = delta.content;
		} else if (typeof choice.text === 'string' && choice.text.length > 0) {
			// Legacy completions endpoint (FIM) reports plain text instead of a delta object.
			textDelta = choice.text;
		}

		// Reported separately by OpenAI but combined by some gateways, so the finish reason
		// must not shadow the payload of the very same frame.
		const finishReason = choice.finish_reason
			? toFinishReason(choice.finish_reason)
			: undefined;

		const chunk: MutableStreamChunk = {};
		if (toolCallDeltas) {
			chunk.toolCallDeltas = toolCallDeltas;
		} else if (textDelta !== undefined) {
			chunk.textDelta = textDelta;
		}
		if (finishReason !== undefined) {
			chunk.finishReason = finishReason;
		}
		return Object.keys(chunk).length > 0 ? chunk : undefined;
	}
}

function createHeaders(endpoint: ILLMEndpoint): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		Accept: 'text/event-stream',
		Authorization: `Bearer ${endpoint.apiKey}`,
	};
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

function toOpenAIMessage(message: ILLMMessage): IOpenAIMessage {
	const result: IOpenAIMessage = {
		role: message.role,
		content: message.content,
	};
	if (message.toolCallId) {
		result.tool_call_id = message.toolCallId;
	}
	if (message.toolCalls && message.toolCalls.length > 0) {
		result.tool_calls = message.toolCalls.map((call) => ({
			id: call.id,
			type: 'function',
			function: { name: call.name, arguments: call.arguments },
		}));
	}
	return result;
}

function toFinishReason(reason: string): LLMFinishReason {
	switch (reason) {
		case 'tool_calls':
			return LLMFinishReason.ToolCalls;
		case 'length':
			return LLMFinishReason.Length;
		case 'content_filter':
			return LLMFinishReason.ContentFilter;
		default:
			return LLMFinishReason.Stop;
	}
}

/** `[DONE]` sentinel closing an OpenAI compatible stream. */
const SSE_DONE = '[DONE]';

function toRequestError(
	message: string,
	statusCode: number | undefined,
): LLMRequestError {
	return new LLMRequestError(
		message,
		statusCode,
		isRetryableStatus(statusCode),
		LLMProviderKind.OpenAICompatible,
	);
}

/** Shared by all OpenAI compatible gateways: `{ "error": { "message": ... } }`. */
function extractErrorMessage(body: string): string | undefined {
	try {
		const json = JSON.parse(body) as { error?: { message?: string } | string };
		if (typeof json.error === 'string') {
			return json.error;
		}
		return json.error?.message;
	} catch {
		return undefined;
	}
}

function isRetryableStatus(statusCode: number | undefined): boolean {
	return (
		statusCode === 429 ||
		statusCode === 408 ||
		(statusCode !== undefined && statusCode >= 500)
	);
}

// --- Wire format types (kept local, the API is not part of our public surface) ---

/** Mutable view of {@link ILLMStreamChunk} used while a single frame is decoded. */
type MutableStreamChunk = {
	textDelta?: string;
	toolCallDeltas?: ILLMToolCallDelta[];
	finishReason?: LLMFinishReason;
};

interface IOpenAIMessage {
	role: string;
	content: string;
	tool_call_id?: string;
	tool_calls?: {
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}[];
}

interface IOpenAIChatRequestBody {
	model: string;
	messages: IOpenAIMessage[];
	stream: boolean;
	stream_options: { include_usage: boolean };
	temperature?: number;
	max_tokens?: number;
	stop?: string[];
	tools?: {
		type: 'function';
		function: { name: string; description: string; parameters: unknown };
	}[];
	tool_choice?: string;
}

interface IOpenAIStreamChunkJson {
	choices?: {
		delta?: {
			content?: string;
			tool_calls?: {
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}[];
		};
		text?: string;
		finish_reason?: string;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface IOpenAIEmbeddingResponse {
	data: { embedding: number[] }[];
	model?: string;
	usage?: { prompt_tokens?: number };
}
