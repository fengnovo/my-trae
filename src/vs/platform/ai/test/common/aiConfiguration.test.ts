/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { LLMProviderKind } from '../../common/ai.js';
import {
	AI_CONFIG_SECTION,
	readAIConfiguration,
} from '../../common/aiConfiguration.js';
import {
	DEFAULT_PROVIDER_ID,
	findProviderPreset,
} from '../../common/modelCatalog.js';

function read(configuration: Record<string, unknown> = {}) {
	return readAIConfiguration(new TestConfigurationService(configuration));
}

suite('AI configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the section name matches the declared settings prefix', () => {
		assert.strictEqual(AI_CONFIG_SECTION, 'myTrae');
	});

	test('falls back to the default provider preset', () => {
		const preset = findProviderPreset(DEFAULT_PROVIDER_ID)!;
		const configuration = read();

		assert.strictEqual(configuration.providerId, DEFAULT_PROVIDER_ID);
		assert.strictEqual(configuration.kind, preset.kind);
		assert.strictEqual(configuration.baseUrl, preset.baseUrl);
		assert.strictEqual(configuration.chatModel, preset.models[0].id);
		assert.strictEqual(configuration.completionModel, '');
		assert.strictEqual(configuration.agentModel, '');
	});

	test('applies the documented defaults', () => {
		const configuration = read();

		assert.strictEqual(configuration.temperature, 0.2);
		assert.strictEqual(configuration.maxTokens, 4096);
		assert.strictEqual(configuration.completionEnabled, true);
		assert.strictEqual(configuration.completionDebounceMs, 300);
		assert.strictEqual(configuration.completionMaxPrefixLines, 60);
		assert.strictEqual(configuration.agentAutoApproveReads, true);
		assert.strictEqual(configuration.agentMaxSteps, 25);
		assert.strictEqual(configuration.indexingEnabled, true);
	});

	test('keeps an explicitly configured temperature of zero', () => {
		const configuration = read({ myTrae: { temperature: 0 } });

		assert.strictEqual(configuration.temperature, 0);
	});

	test('follows the selected provider preset', () => {
		const configuration = read({ myTrae: { provider: 'anthropic' } });

		assert.strictEqual(configuration.providerId, 'anthropic');
		assert.strictEqual(configuration.kind, LLMProviderKind.Anthropic);
		assert.strictEqual(configuration.baseUrl, 'https://api.anthropic.com');
		assert.strictEqual(configuration.chatModel, 'claude-sonnet-4-5');
	});

	test('lets explicit values win over the preset', () => {
		const configuration = read({
			myTrae: {
				provider: 'anthropic',
				baseUrl: 'https://gateway.internal/anthropic',
				model: 'custom-model',
				completionModel: 'fast-model',
				agentModel: 'tool-model',
				maxTokens: 1024,
			},
		});

		assert.strictEqual(
			configuration.baseUrl,
			'https://gateway.internal/anthropic',
		);
		assert.strictEqual(configuration.chatModel, 'custom-model');
		assert.strictEqual(configuration.completionModel, 'fast-model');
		assert.strictEqual(configuration.agentModel, 'tool-model');
		assert.strictEqual(configuration.maxTokens, 1024);
	});

	test('degrades gracefully for an unknown provider', () => {
		const configuration = read({
			myTrae: { provider: 'not-a-preset', baseUrl: 'https://example.com/v1' },
		});

		assert.strictEqual(configuration.providerId, 'not-a-preset');
		assert.strictEqual(configuration.kind, LLMProviderKind.OpenAICompatible);
		assert.strictEqual(configuration.baseUrl, 'https://example.com/v1');
		assert.strictEqual(configuration.chatModel, '');
	});

	test('embedding settings follow the main provider unless overridden', () => {
		const inherited = read({ myTrae: { provider: 'qwen' } });
		assert.strictEqual(inherited.embedding.providerId, 'qwen');
		assert.strictEqual(
			inherited.embedding.baseUrl,
			findProviderPreset('qwen')!.baseUrl,
		);
		assert.strictEqual(inherited.embedding.model, 'text-embedding-v3');

		const overridden = read({
			myTrae: {
				provider: 'anthropic',
				embedding: {
					provider: 'qwen',
					baseUrl: 'https://embed.internal/v1',
					model: 'bge-m3',
				},
			},
		});
		assert.strictEqual(overridden.embedding.providerId, 'qwen');
		assert.strictEqual(
			overridden.embedding.baseUrl,
			'https://embed.internal/v1',
		);
		assert.strictEqual(overridden.embedding.model, 'bge-m3');
	});
});
