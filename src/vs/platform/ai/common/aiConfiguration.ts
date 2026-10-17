/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configuration.js';
import { LLMProviderKind } from './ai.js';
import { DEFAULT_PROVIDER_ID, findProviderPreset } from './modelCatalog.js';

/**
 * Configuration contract of the AI features. Keys are declared here (platform layer) so
 * that services, the settings schema and the indexer all read the same names; the JSON
 * schema itself is contributed from the workbench.
 */

export const AI_CONFIG_SECTION = 'myTrae';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-v3';

export const enum AIConfig {
	Provider = 'myTrae.provider',
	BaseUrl = 'myTrae.baseUrl',
	Model = 'myTrae.model',
	CompletionModel = 'myTrae.completionModel',
	AgentModel = 'myTrae.agentModel',
	Temperature = 'myTrae.temperature',
	MaxTokens = 'myTrae.maxTokens',
	EmbeddingProvider = 'myTrae.embedding.provider',
	EmbeddingBaseUrl = 'myTrae.embedding.baseUrl',
	EmbeddingModel = 'myTrae.embedding.model',
	CompletionEnabled = 'myTrae.completion.enabled',
	CompletionDebounceMs = 'myTrae.completion.debounceMs',
	CompletionMaxPrefixLines = 'myTrae.completion.maxPrefixLines',
	AgentAutoApproveReads = 'myTrae.agent.autoApproveReads',
	AgentMaxSteps = 'myTrae.agent.maxSteps',
	AgentSearchUrl = 'myTrae.agent.searchUrl',
	AgentContextWindow = 'myTrae.agent.contextWindow',
	IndexingEnabled = 'myTrae.indexing.enabled',
}

export interface IAIConfiguration {
	readonly providerId: string;
	readonly kind: LLMProviderKind;
	readonly baseUrl: string;
	readonly chatModel: string;
	readonly completionModel: string;
	readonly agentModel: string;
	readonly temperature: number;
	readonly maxTokens: number;
	readonly embedding: {
		readonly providerId: string;
		readonly baseUrl: string;
		readonly model: string;
	};
	readonly completionEnabled: boolean;
	readonly completionDebounceMs: number;
	readonly completionMaxPrefixLines: number;
	readonly agentAutoApproveReads: boolean;
	readonly agentMaxSteps: number;
	readonly indexingEnabled: boolean;
}

export function readAIConfiguration(
	configurationService: IConfigurationService,
): IAIConfiguration {
	const providerId =
		configurationService.getValue<string>(AIConfig.Provider) ||
		DEFAULT_PROVIDER_ID;
	const preset = findProviderPreset(providerId);
	const embeddingProviderId =
		configurationService.getValue<string>(AIConfig.EmbeddingProvider) ||
		providerId;
	const embeddingPreset = findProviderPreset(embeddingProviderId);

	return {
		providerId,
		kind: preset?.kind ?? LLMProviderKind.OpenAICompatible,
		baseUrl:
			configurationService.getValue<string>(AIConfig.BaseUrl) ||
			preset?.baseUrl ||
			'',
		chatModel:
			configurationService.getValue<string>(AIConfig.Model) ||
			preset?.models[0]?.id ||
			'',
		completionModel:
			configurationService.getValue<string>(AIConfig.CompletionModel) || '',
		agentModel:
			configurationService.getValue<string>(AIConfig.AgentModel) || '',
		temperature:
			configurationService.getValue<number>(AIConfig.Temperature) ?? 0.2,
		maxTokens:
			configurationService.getValue<number>(AIConfig.MaxTokens) ?? 4096,
		embedding: {
			providerId: embeddingProviderId,
			baseUrl:
				configurationService.getValue<string>(AIConfig.EmbeddingBaseUrl) ||
				embeddingPreset?.baseUrl ||
				'',
			model:
				configurationService.getValue<string>(AIConfig.EmbeddingModel) ||
				DEFAULT_EMBEDDING_MODEL,
		},
		completionEnabled:
			configurationService.getValue<boolean>(AIConfig.CompletionEnabled) ??
			true,
		completionDebounceMs:
			configurationService.getValue<number>(AIConfig.CompletionDebounceMs) ??
			300,
		completionMaxPrefixLines:
			configurationService.getValue<number>(
				AIConfig.CompletionMaxPrefixLines,
			) ?? 60,
		agentAutoApproveReads:
			configurationService.getValue<boolean>(AIConfig.AgentAutoApproveReads) ??
			true,
		agentMaxSteps:
			configurationService.getValue<number>(AIConfig.AgentMaxSteps) ?? 25,
		indexingEnabled:
			configurationService.getValue<boolean>(AIConfig.IndexingEnabled) ?? true,
	};
}
