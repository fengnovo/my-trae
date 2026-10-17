/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { IRequestService } from '../../request/common/request.js';
import {
	AIConfigurationError,
	AIRequestPurpose,
	IAICredentialsService,
	IEmbeddingRequest,
	IEmbeddingResponse,
	ILLMEndpoint,
	ILLMProvider,
	ILLMRequest,
	ILLMResponse,
	ILLMService,
	ILLMStreamChunk,
	IModelInfo,
	LLMProviderKind,
	LLMRequestError,
} from './ai.js';
import {
	AI_CONFIG_SECTION,
	IAIConfiguration,
	readAIConfiguration,
} from './aiConfiguration.js';
import { IAITransport, RequestServiceTransport } from './aiTransport.js';
import { AnthropicProvider } from './anthropicProvider.js';
import { findProviderPreset, listCatalogModels } from './modelCatalog.js';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider.js';
import { aggregateStream } from './streamAggregator.js';

/** Total attempts for a retryable failure (one initial try plus retries). */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Entry point of every AI feature. Resolves the configured provider into an endpoint,
 * applies retry/backoff and keeps inline completion traffic from starving interactive
 * chat and agent requests.
 */
export class LLMService extends Disposable implements ILLMService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConfiguration = this._register(
		new Emitter<void>(),
	);
	readonly onDidChangeConfiguration: Event<void> =
		this._onDidChangeConfiguration.event;

	private readonly transport: IAITransport;
	private readonly providers: Map<LLMProviderKind, ILLMProvider>;
	private readonly completionGate = new ConcurrencyGate(2);
	private readonly interactiveGate = new ConcurrencyGate(3);

	/** Providers for which a key has been read at least once, used by the sync check. */
	private readonly providersWithKey = new Set<string>();

	constructor(
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@IAICredentialsService
		private readonly credentialsService: IAICredentialsService,
		@IRequestService requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.transport = new RequestServiceTransport(requestService);
		this._register(this.completionGate);
		this._register(this.interactiveGate);
		this.providers = new Map<LLMProviderKind, ILLMProvider>([
			[
				LLMProviderKind.OpenAICompatible,
				new OpenAICompatibleProvider(this.transport),
			],
			[LLMProviderKind.Anthropic, new AnthropicProvider(this.transport)],
		]);

		this._register(
			this.configurationService.onDidChangeConfiguration((event) => {
				// Any key under the section can change model routing or the endpoint itself.
				if (event.affectsConfiguration(AI_CONFIG_SECTION)) {
					this._onDidChangeConfiguration.fire();
				}
			}),
		);
		this._register(
			this.credentialsService.onDidChange((providerId) => {
				this.providersWithKey.add(providerId);
				this._onDidChangeConfiguration.fire();
			}),
		);
	}

	isConfigured(purpose: AIRequestPurpose = AIRequestPurpose.Chat): boolean {
		const configuration = readAIConfiguration(this.configurationService);
		if (purpose === AIRequestPurpose.Embedding) {
			return (
				configuration.embedding.baseUrl.length > 0 &&
				configuration.embedding.model.length > 0
			);
		}
		if (
			configuration.baseUrl.length === 0 ||
			selectModel(configuration, purpose).length === 0
		) {
			return false;
		}
		// Local endpoints (Ollama, LM Studio) work without a key.
		return (
			findProviderPreset(configuration.providerId)?.local === true ||
			this.providersWithKey.has(configuration.providerId)
		);
	}

	listModels(): readonly IModelInfo[] {
		return listCatalogModels();
	}

	async resolveEndpoint(purpose: AIRequestPurpose): Promise<ILLMEndpoint> {
		const configuration = readAIConfiguration(this.configurationService);

		if (purpose === AIRequestPurpose.Embedding) {
			const providerId = configuration.embedding.providerId;
			return {
				kind:
					findProviderPreset(providerId)?.kind ??
					LLMProviderKind.OpenAICompatible,
				baseUrl: requireValue(
					configuration.embedding.baseUrl,
					'myTrae.embedding.baseUrl',
				),
				apiKey: await this.resolveApiKey(providerId),
				model: requireValue(
					configuration.embedding.model,
					'myTrae.embedding.model',
				),
			};
		}

		return {
			kind: configuration.kind,
			baseUrl: requireValue(configuration.baseUrl, 'myTrae.baseUrl'),
			apiKey: await this.resolveApiKey(configuration.providerId),
			model: requireValue(selectModel(configuration, purpose), 'myTrae.model'),
		};
	}

	async *streamChat(
		request: ILLMRequest,
		token: AbortSignal,
	): AsyncIterable<ILLMStreamChunk> {
		const endpoint = await this.resolveEndpoint(request.purpose);
		const provider = this.providerFor(endpoint.kind);
		const normalized = this.applyDefaults(request, endpoint);
		const gate =
			request.purpose === AIRequestPurpose.Completion
				? this.completionGate
				: this.interactiveGate;

		await gate.acquire();
		try {
			let attempt = 0;
			let yielded = false;

			while (true) {
				const iterator = provider
					.streamChat(endpoint, normalized, token)
					[Symbol.asyncIterator]();
				try {
					let next = await iterator.next();
					while (!next.done) {
						yielded = true;
						yield next.value;
						next = await iterator.next();
					}
					return;
				} catch (error) {
					// Retrying after tokens reached the caller would duplicate output, so
					// only failures before the first chunk are eligible.
					if (
						yielded ||
						token.aborted ||
						attempt + 1 >= MAX_ATTEMPTS ||
						!isRetryable(error)
					) {
						throw error;
					}
					attempt++;
					const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
					this.logService.warn(
						`[ai] retrying ${endpoint.model} request in ${backoff}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${errorMessage(error)}`,
					);
					await timeout(backoff);
				}
			}
		} finally {
			gate.release();
		}
	}

	async chat(request: ILLMRequest, token: AbortSignal): Promise<ILLMResponse> {
		return aggregateStream(this.streamChat(request, token));
	}

	async embed(
		request: IEmbeddingRequest,
		token: AbortSignal,
	): Promise<IEmbeddingResponse> {
		const endpoint = await this.resolveEndpoint(AIRequestPurpose.Embedding);
		const provider = this.providerFor(endpoint.kind);

		let attempt = 0;
		while (true) {
			try {
				return await provider.embed(endpoint, request, token);
			} catch (error) {
				if (
					token.aborted ||
					attempt + 1 >= MAX_ATTEMPTS ||
					!isRetryable(error)
				) {
					throw error;
				}
				attempt++;
				await timeout(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
			}
		}
	}

	private providerFor(kind: LLMProviderKind): ILLMProvider {
		const provider = this.providers.get(kind);
		if (!provider) {
			throw new AIConfigurationError(
				`No provider implementation registered for '${kind}'.`,
			);
		}
		return provider;
	}

	private async resolveApiKey(providerId: string): Promise<string> {
		const key = await this.credentialsService.getApiKey(providerId);
		if (key) {
			this.providersWithKey.add(providerId);
			return key;
		}
		if (findProviderPreset(providerId)?.local === true) {
			// Local servers accept any value; keep the header well formed.
			return 'not-needed';
		}
		throw new AIConfigurationError(
			`No API key stored for '${providerId}'. Run "MyTrae: Set API Key" from the command palette.`,
		);
	}

	/** Applies configured sampling defaults and the purpose specific model. */
	private applyDefaults(
		request: ILLMRequest,
		endpoint: ILLMEndpoint,
	): ILLMRequest {
		const configuration = readAIConfiguration(this.configurationService);
		return {
			...request,
			model: request.model ?? endpoint.model,
			temperature:
				request.temperature ??
				(request.purpose === AIRequestPurpose.Completion
					? 0
					: configuration.temperature),
			maxTokens:
				request.maxTokens ??
				(request.purpose === AIRequestPurpose.Completion
					? 512
					: configuration.maxTokens),
		};
	}

	override dispose(): void {
		this.completionGate.dispose();
		this.interactiveGate.dispose();
		super.dispose();
	}
}

function selectModel(
	configuration: IAIConfiguration,
	purpose: AIRequestPurpose,
): string {
	switch (purpose) {
		case AIRequestPurpose.Completion:
			return configuration.completionModel || configuration.chatModel;
		case AIRequestPurpose.Agent:
			return configuration.agentModel || configuration.chatModel;
		default:
			return configuration.chatModel;
	}
}

function requireValue(value: string, settingId: string): string {
	if (value.length === 0) {
		throw new AIConfigurationError(`'${settingId}' is not configured.`);
	}
	return value;
}

function isRetryable(error: unknown): boolean {
	return error instanceof LLMRequestError && error.retryable;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Minimal counting semaphore. Completion and interactive traffic use separate instances
 * so that a burst of typing cannot block an in-flight chat or agent turn.
 */
class ConcurrencyGate {
	private active = 0;
	private readonly waiting: (() => void)[] = [];
	private disposed = false;

	constructor(private readonly limit: number) {}

	acquire(): Promise<void> {
		if (this.disposed || this.active < this.limit) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.waiting.push(resolve));
	}

	release(): void {
		const next = this.waiting.shift();
		if (next) {
			next();
			return;
		}
		this.active = Math.max(0, this.active - 1);
	}

	dispose(): void {
		this.disposed = true;
		while (this.waiting.length > 0) {
			this.waiting.shift()!();
		}
	}
}
