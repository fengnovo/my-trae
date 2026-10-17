/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelInfo, LLMProviderKind } from './ai.js';

/**
 * Catalogue of provider presets shown in the settings picker. Users may still type any
 * base URL and model id, so this list is a convenience, not a restriction.
 */

export interface IProviderPreset {
	readonly id: string;
	readonly label: string;
	readonly kind: LLMProviderKind;
	readonly baseUrl: string;
	readonly models: readonly IModelInfo[];
	/** True when the endpoint runs on the user's machine and needs no API key. */
	readonly local: boolean;
}

function model(
	provider: string,
	id: string,
	contextWindow: number,
	options: {
		supportsTools?: boolean;
		supportsFim?: boolean;
		label?: string;
		kind?: LLMProviderKind;
	} = {},
): IModelInfo {
	return {
		id,
		provider,
		label: options.label ?? id,
		contextWindow,
		supportsTools: options.supportsTools ?? true,
		supportsFim: options.supportsFim ?? false,
		kind: options.kind ?? LLMProviderKind.OpenAICompatible,
	};
}

export const BUILT_IN_PROVIDERS: readonly IProviderPreset[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		kind: LLMProviderKind.OpenAICompatible,
		baseUrl: 'https://api.openai.com/v1',
		local: false,
		models: [
			model('openai', 'gpt-4o', 128000),
			model('openai', 'gpt-4o-mini', 128000),
			model('openai', 'gpt-4.1', 1047576),
			model('openai', 'gpt-4.1-mini', 1047576),
			model('openai', 'o4-mini', 200000),
		],
	},
	{
		id: 'anthropic',
		label: 'Anthropic',
		kind: LLMProviderKind.Anthropic,
		baseUrl: 'https://api.anthropic.com',
		local: false,
		models: [
			model('anthropic', 'claude-sonnet-4-5', 200000, {
				kind: LLMProviderKind.Anthropic,
			}),
			model('anthropic', 'claude-opus-4-1', 200000, {
				kind: LLMProviderKind.Anthropic,
			}),
			model('anthropic', 'claude-3-5-haiku-latest', 200000, {
				kind: LLMProviderKind.Anthropic,
			}),
		],
	},
	{
		id: 'deepseek',
		label: 'DeepSeek',
		kind: LLMProviderKind.OpenAICompatible,
		baseUrl: 'https://api.deepseek.com/v1',
		local: false,
		models: [
			model('deepseek', 'deepseek-chat', 64000),
			model('deepseek', 'deepseek-reasoner', 64000, { supportsTools: false }),
			model('deepseek', 'deepseek-coder', 64000, { supportsFim: true }),
		],
	},
	{
		id: 'qwen',
		label: 'Qwen (DashScope)',
		kind: LLMProviderKind.OpenAICompatible,
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		local: false,
		models: [
			model('qwen', 'qwen3-coder-plus', 262144, { supportsFim: true }),
			model('qwen', 'qwen-plus', 131072),
			model('qwen', 'qwen-max', 32768),
			model('qwen', 'text-embedding-v3', 8192, {
				supportsTools: false,
				label: 'text-embedding-v3 (embedding)',
			}),
		],
	},
	{
		id: 'moonshot',
		label: 'Moonshot (Kimi)',
		kind: LLMProviderKind.OpenAICompatible,
		baseUrl: 'https://api.moonshot.cn/v1',
		local: false,
		models: [
			model('moonshot', 'moonshot-v1-8k', 8000),
			model('moonshot', 'moonshot-v1-32k', 32000),
			model('moonshot', 'moonshot-v1-128k', 128000),
		],
	},
	{
		id: 'zhipu',
		label: 'Zhipu (GLM)',
		kind: LLMProviderKind.OpenAICompatible,
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		local: false,
		models: [
			model('zhipu', 'glm-4-plus', 128000),
			model('zhipu', 'glm-4-air', 128000),
			model('zhipu', 'codegeex-4', 128000, { supportsFim: true }),
		],
	},
	{
		id: 'ollama',
		label: 'Ollama (local)',
		kind: LLMProviderKind.OpenAICompatible,
		baseUrl: 'http://localhost:11434/v1',
		local: true,
		models: [
			model('ollama', 'qwen2.5-coder:7b', 32000, { supportsFim: true }),
			model('ollama', 'qwen2.5-coder:1.5b', 32000, { supportsFim: true }),
			model('ollama', 'deepseek-coder-v2:16b', 32000, { supportsFim: true }),
			model('ollama', 'llama3.1:8b', 32000),
		],
	},
	{
		id: 'lmstudio',
		label: 'LM Studio (local)',
		kind: LLMProviderKind.OpenAICompatible,
		baseUrl: 'http://localhost:1234/v1',
		local: true,
		models: [
			model('lmstudio', 'local-model', 32000, {
				label: 'local-model (any loaded model)',
			}),
		],
	},
];

/** Default provider used when nothing is configured yet. */
export const DEFAULT_PROVIDER_ID = 'deepseek';

/** Models offered for codebase indexing embeddings. */
export const DEFAULT_EMBEDDING_MODELS: readonly string[] = [
	'text-embedding-v3',
	'text-embedding-3-small',
	'text-embedding-3-large',
	'bge-m3',
	'nomic-embed-text',
];

export function findProviderPreset(id: string): IProviderPreset | undefined {
	return BUILT_IN_PROVIDERS.find((provider) => provider.id === id);
}

export function listCatalogModels(): readonly IModelInfo[] {
	return BUILT_IN_PROVIDERS.flatMap((provider) => provider.models);
}

export function providerIds(): readonly string[] {
	return BUILT_IN_PROVIDERS.map((provider) => provider.id);
}
