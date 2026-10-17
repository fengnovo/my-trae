/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Core types shared by every AI feature (chat, inline completion, agent, indexing).
 * Kept free of workbench and electron dependencies so that the same contracts can be
 * consumed from the renderer, the extension host and the indexer utility process.
 */

export const enum LLMProviderKind {
	OpenAICompatible = 'openai-compatible',
	Anthropic = 'anthropic',
}

/** Why a request is issued. Used for model routing and for separate concurrency queues. */
export const enum AIRequestPurpose {
	Chat = 'chat',
	Completion = 'completion',
	Agent = 'agent',
	Embedding = 'embedding',
}

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ILLMToolCall {
	readonly id: string;
	readonly name: string;
	/** Raw JSON argument string as produced by the model. */
	readonly arguments: string;
}

export interface ILLMMessage {
	readonly role: LLMRole;
	readonly content: string;
	readonly toolCalls?: readonly ILLMToolCall[];
	/** Required when `role === 'tool'`. */
	readonly toolCallId?: string;
}

export interface ILLMTool {
	readonly name: string;
	readonly description: string;
	/** JSON schema of the tool parameters. */
	readonly parameters: unknown;
}

export interface ILLMRequest {
	readonly messages: readonly ILLMMessage[];
	readonly purpose: AIRequestPurpose;
	/** Overrides the model configured for `purpose` when set. */
	readonly model?: string;
	readonly tools?: readonly ILLMTool[];
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly stop?: readonly string[];
	/** Fill-in-the-middle context used by inline completion. */
	readonly prefix?: string;
	readonly suffix?: string;
}

export const enum LLMFinishReason {
	Stop = 'stop',
	ToolCalls = 'tool_calls',
	Length = 'length',
	ContentFilter = 'content_filter',
	Error = 'error',
}

export interface ILLMUsage {
	readonly promptTokens?: number;
	readonly completionTokens?: number;
}

/** Incremental piece of a streamed tool call. `index` groups deltas of the same call. */
export interface ILLMToolCallDelta {
	readonly index: number;
	readonly id?: string;
	readonly nameDelta?: string;
	readonly argumentsDelta?: string;
}

/**
 * One increment of a streaming response. Usually a single payload field is set, but a
 * gateway may report the last text delta together with the finish reason.
 */
export interface ILLMStreamChunk {
	readonly textDelta?: string;
	readonly toolCallDeltas?: readonly ILLMToolCallDelta[];
	readonly finishReason?: LLMFinishReason;
	readonly usage?: ILLMUsage;
}

/** Aggregated result of a non-streaming call. */
export interface ILLMResponse {
	readonly content: string;
	readonly toolCalls: readonly ILLMToolCall[];
	readonly finishReason?: LLMFinishReason;
	readonly usage?: ILLMUsage;
}

/** Failure of an LLM call. `retryable` drives the backoff policy in the service layer. */
export class LLMRequestError extends Error {
	constructor(
		message: string,
		readonly statusCode: number | undefined,
		readonly retryable: boolean,
		readonly providerKind: LLMProviderKind,
	) {
		super(message);
		this.name = 'LLMRequestError';
	}
}

/**
 * Thrown when a request cannot be issued because provider, model or API key are missing.
 * Separate from {@link LLMRequestError} so the UI can offer a "configure" action instead
 * of a retry.
 */
export class AIConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AIConfigurationError';
	}
}

export interface IEmbeddingRequest {
	readonly input: readonly string[];
	readonly model?: string;
}

export interface IEmbeddingResponse {
	readonly embeddings: readonly (readonly number[])[];
	readonly model: string;
	readonly usage?: ILLMUsage;
}

/** Resolved runtime configuration of a single provider endpoint. */
export interface ILLMEndpoint {
	readonly kind: LLMProviderKind;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly model: string;
}

export interface IModelInfo {
	readonly id: string;
	readonly provider: string;
	readonly label: string;
	readonly contextWindow: number;
	readonly supportsTools: boolean;
	readonly supportsFim: boolean;
	readonly kind: LLMProviderKind;
}

/**
 * Transport abstraction. One implementation per provider family. Implementations must
 * be free of workbench dependencies so they stay unit testable.
 */
export interface ILLMProvider {
	readonly kind: LLMProviderKind;
	streamChat(
		endpoint: ILLMEndpoint,
		request: ILLMRequest,
		token: AbortSignal,
	): AsyncIterable<ILLMStreamChunk>;
	embed(
		endpoint: ILLMEndpoint,
		request: IEmbeddingRequest,
		token: AbortSignal,
	): Promise<IEmbeddingResponse>;
}

export const ILLMService = createDecorator<ILLMService>('llmService');

export interface ILLMService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeConfiguration: Event<void>;

	/** False until a provider, model and API key are all available. */
	isConfigured(purpose?: AIRequestPurpose): boolean;

	listModels(): readonly IModelInfo[];

	resolveEndpoint(purpose: AIRequestPurpose): Promise<ILLMEndpoint>;

	/** Streaming chat/agent completion. Aggregating helpers build on top of this. */
	streamChat(
		request: ILLMRequest,
		token: AbortSignal,
	): AsyncIterable<ILLMStreamChunk>;

	/** Convenience wrapper collecting the whole streamed response. */
	chat(request: ILLMRequest, token: AbortSignal): Promise<ILLMResponse>;

	embed(
		request: IEmbeddingRequest,
		token: AbortSignal,
	): Promise<IEmbeddingResponse>;
}

/**
 * Encrypted storage for provider credentials. Implemented on top of the platform
 * encryption service (Electron `safeStorage` / OS keychain); keys never hit disk in
 * clear text and never appear in settings.json.
 */
export const IAICredentialsService = createDecorator<IAICredentialsService>(
	'aiCredentialsService',
);

export interface IAICredentialsService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<string>;

	getApiKey(providerId: string): Promise<string | undefined>;
	storeApiKey(providerId: string, value: string): Promise<void>;
	deleteApiKey(providerId: string): Promise<void>;
	/** True when OS level encryption is usable, false when the value would be stored obfuscated only. */
	isEncryptionAvailable(): Promise<boolean>;
}
