/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { LLMProviderKind } from '../../common/ai.js';
import {
	BUILT_IN_PROVIDERS,
	DEFAULT_EMBEDDING_MODELS,
	DEFAULT_PROVIDER_ID,
	findProviderPreset,
	listCatalogModels,
	providerIds,
} from '../../common/modelCatalog.js';

suite('AI modelCatalog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every preset is fully described', () => {
		assert.ok(BUILT_IN_PROVIDERS.length > 0);

		for (const preset of BUILT_IN_PROVIDERS) {
			assert.ok(preset.id.length > 0, 'preset id must not be empty');
			assert.ok(preset.label.length > 0, `${preset.id} needs a label`);
			assert.match(
				preset.baseUrl,
				/^https?:\/\//,
				`${preset.id} needs an absolute base URL`,
			);
			assert.ok(
				preset.models.length > 0,
				`${preset.id} needs at least one model`,
			);
		}
	});

	test('preset ids are unique', () => {
		const ids = providerIds();
		assert.strictEqual(new Set(ids).size, ids.length);
		assert.deepStrictEqual(
			ids,
			BUILT_IN_PROVIDERS.map((preset) => preset.id),
		);
	});

	test('models agree with their preset', () => {
		for (const preset of BUILT_IN_PROVIDERS) {
			for (const model of preset.models) {
				assert.strictEqual(
					model.provider,
					preset.id,
					`${model.id} points at the wrong provider`,
				);
				assert.strictEqual(
					model.kind,
					preset.kind,
					`${model.id} uses the wrong transport`,
				);
				assert.ok(
					model.contextWindow > 0,
					`${model.id} needs a context window`,
				);
				assert.ok(model.label.length > 0, `${model.id} needs a label`);
			}
		}
	});

	test('the default provider exists and is not a local one', () => {
		const preset = findProviderPreset(DEFAULT_PROVIDER_ID);
		assert.ok(preset);
		assert.strictEqual(
			preset.local,
			false,
			'the default must work without a local runtime',
		);
		assert.strictEqual(preset.models[0].supportsTools, true);
	});

	test('exposes both provider families', () => {
		const kinds = new Set(BUILT_IN_PROVIDERS.map((preset) => preset.kind));
		assert.ok(kinds.has(LLMProviderKind.OpenAICompatible));
		assert.ok(kinds.has(LLMProviderKind.Anthropic));
	});

	test('offers local runtimes that need no API key', () => {
		const localPresets = BUILT_IN_PROVIDERS.filter((preset) => preset.local);
		assert.ok(localPresets.length >= 2);
		for (const preset of localPresets) {
			assert.match(
				preset.baseUrl,
				/^http:\/\/localhost/,
				`${preset.id} should point at the local machine`,
			);
		}
	});

	test('offers fill-in-the-middle models for inline completion', () => {
		const fimModels = listCatalogModels().filter((model) => model.supportsFim);
		assert.ok(fimModels.length > 0);
	});

	test('lists every catalog model exactly once', () => {
		const total = BUILT_IN_PROVIDERS.reduce(
			(sum, preset) => sum + preset.models.length,
			0,
		);
		assert.strictEqual(listCatalogModels().length, total);
	});

	test('suggests embedding models for indexing', () => {
		assert.ok(DEFAULT_EMBEDDING_MODELS.length > 0);
		assert.strictEqual(
			new Set(DEFAULT_EMBEDDING_MODELS).size,
			DEFAULT_EMBEDDING_MODELS.length,
		);
	});

	test('returns undefined for an unknown preset', () => {
		assert.strictEqual(findProviderPreset('does-not-exist'), undefined);
	});
});
