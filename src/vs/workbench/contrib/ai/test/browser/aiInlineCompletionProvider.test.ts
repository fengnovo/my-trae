/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	CancellationToken,
	CancellationTokenSource,
} from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import {
	CompletionItemKind,
	InlineCompletionContext,
	InlineCompletionTriggerKind,
	SelectedSuggestionInfo,
} from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import {
	AIRequestPurpose,
	ILLMRequest,
	ILLMResponse,
	ILLMService,
} from '../../../../../platform/ai/common/ai.js';
import { CodeIndexState, ICodeIndexHit, ICodeIndexService } from '../../../../../platform/ai/common/codeIndex.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import {
	assembleCompletionContext,
	buildCompletionPrompt,
	CompletionCache,
	DEFAULT_COMPLETION_CONTEXT_OPTIONS,
	MyTraeInlineCompletionProvider,
	sanitizeCompletion,
} from '../../browser/aiInlineCompletionProvider.js';

function completionContext(
	overrides?: Partial<InlineCompletionContext>,
): InlineCompletionContext {
	return {
		triggerKind: InlineCompletionTriggerKind.Automatic,
		selectedSuggestionInfo: undefined,
		requestUuid: 'test-request',
		includeInlineEdits: false,
		includeInlineCompletions: true,
		requestIssuedDateTime: Date.now(),
		earliestShownDateTime: Date.now(),
		...overrides,
	};
}

suite('MyTrae inline completion context assembly', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('splits the document at the cursor and caps prefix lines', () => {
		const lines: string[] = [];
		for (let i = 1; i <= 100; i++) {
			lines.push(`line ${i}`);
		}
		const model = store.add(
			createTextModel(lines.join('\n'), 'typescript', {}, URI.file('/workspace/big.ts')),
		);

		const context = assembleCompletionContext(model, new Position(90, 4), {
			...DEFAULT_COMPLETION_CONTEXT_OPTIONS,
			maxPrefixLines: 10,
		});

		const prefixLines = context.prefix.split('\n');
		assert.strictEqual(prefixLines.length, 11);
		assert.strictEqual(prefixLines[0], 'line 80');
		assert.strictEqual(prefixLines[10], 'lin');
		assert.strictEqual(context.linePrefix, 'lin');
		assert.strictEqual(context.lineSuffix, 'e 90');
		assert.ok(context.suffix.startsWith('e 90\nline 91'));
		assert.strictEqual(context.languageId, 'typescript');
		assert.strictEqual(context.fileName, 'big.ts');
	});

	test('caps prefix and suffix by characters', () => {
		const model = store.add(
			createTextModel('abcdefghij\nklmnopqrst\nuvwxyz', 'typescript', {}, URI.file('/workspace/small.ts')),
		);

		const context = assembleCompletionContext(model, new Position(2, 6), {
			maxPrefixLines: 60,
			maxSuffixLines: 60,
			maxPrefixChars: 8,
			maxSuffixChars: 9,
		});

		assert.strictEqual(context.prefix, 'ij\nklmno');
		assert.strictEqual(context.suffix, 'pqrst\nuvw');
	});

	test('prompt places the cursor marker between prefix and suffix', () => {
		const model = store.add(
			createTextModel('const a = 1;\nconst b = ', 'typescript', {}, URI.file('/workspace/prompt.ts')),
		);
		const context = assembleCompletionContext(model, new Position(2, 11));
		const prompt = buildCompletionPrompt(context);

		assert.ok(prompt.includes('const a = 1;\nconst b = <cursor>'));
		assert.ok(prompt.includes('```typescript'));
		assert.ok(prompt.includes('prompt.ts'));
	});
});

suite('MyTrae inline completion sanitizing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips markdown fences', () => {
		assert.strictEqual(
			sanitizeCompletion('```typescript\nconst x = 1;\n```', ''),
			'const x = 1;',
		);
	});

	test('strips an unclosed opening fence', () => {
		assert.strictEqual(
			sanitizeCompletion('```ts\nreturn value;', ''),
			'return value;',
		);
	});

	test('cuts text repeated from after the cursor', () => {
		assert.strictEqual(
			sanitizeCompletion('foo();\n    return x;', '    return x;'),
			'foo();',
		);
	});

	test('keeps trivially short overlaps', () => {
		assert.strictEqual(sanitizeCompletion('foo();', ';'), 'foo();');
	});

	test('rejects empty and whitespace only answers', () => {
		assert.strictEqual(sanitizeCompletion('   \n  ', ''), undefined);
		assert.strictEqual(sanitizeCompletion('```ts\n```', ''), undefined);
	});

	test('rejects pure repetition of the text after the cursor', () => {
		assert.strictEqual(sanitizeCompletion('x;', 'x;'), undefined);
	});

	test('strips an echoed line prefix', () => {
		assert.strictEqual(
			sanitizeCompletion('const f = fibonacci;', '', 'const f = fibo'),
			'nacci;',
		);
	});

	test('strips a short echo without touching the rest', () => {
		assert.strictEqual(
			sanitizeCompletion('g("hi");', '', 'console.lo'),
			'g("hi");',
		);
	});

	test('keeps content when the prefix is not echoed', () => {
		assert.strictEqual(
			sanitizeCompletion('fibonacci(n - 2)', '', 'return fibonacci(n - 1) + '),
			'fibonacci(n - 2)',
		);
	});

	test('rejects an answer that is nothing but echo', () => {
		assert.strictEqual(sanitizeCompletion('fibo', '', 'const f = fibo'), undefined);
	});
});

suite('MyTrae inline completion cache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('serves exact hits and keeps LRU order', () => {
		const cache = new CompletionCache();
		cache.set('file:///a.ts', 1, 'con', 'sole');
		cache.set('file:///a.ts', 2, 'foo', 'bar');

		assert.strictEqual(cache.get('file:///a.ts', 1, 'con'), 'sole');
		cache.set('file:///a.ts', 3, 'x', 'y');
		assert.strictEqual(cache.get('file:///a.ts', 2, 'foo'), 'bar');
	});

	test('serves forward hits while the suggestion is being typed', () => {
		const cache = new CompletionCache();
		cache.set('file:///a.ts', 1, 'console.lo', 'g("hi");');

		assert.strictEqual(cache.get('file:///a.ts', 1, 'console.log'), '("hi");');
		assert.strictEqual(cache.get('file:///a.ts', 1, 'console.lx'), undefined);
		assert.strictEqual(cache.get('file:///a.ts', 2, 'console.lo'), undefined);
	});

	test('drops the oldest entries beyond the cap', () => {
		const cache = new CompletionCache();
		for (let i = 0; i < 60; i++) {
			cache.set('file:///a.ts', i, `p${i}`, `c${i}`);
		}
		assert.strictEqual(cache.get('file:///a.ts', 0, 'p0'), undefined);
		assert.strictEqual(cache.get('file:///a.ts', 59, 'p59'), 'c59');
	});
});

suite('MyTrae inline completion provider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options?: {
		configured?: boolean;
		settings?: Record<string, unknown>;
		response?: string;
		indexState?: CodeIndexState;
		indexHits?: ICodeIndexHit[];
	}) {
		const services = workbenchInstantiationService(undefined, store);
		const configuration = new TestConfigurationService(options?.settings ?? {});
		services.stub(IConfigurationService, configuration);

		const chatCalls: ILLMRequest[] = [];
		const llm = new class extends mock<ILLMService>() {
			override readonly onDidChangeConfiguration = Event.None;
			override isConfigured(): boolean {
				return options?.configured ?? true;
			}
			override async chat(
				request: ILLMRequest,
				token: AbortSignal,
			): Promise<ILLMResponse> {
				if (token.aborted) {
					throw new Error('aborted');
				}
				chatCalls.push(request);
				return { content: options?.response ?? 'g("hi");', toolCalls: [] };
			}
		}();
		services.stub(ILLMService, llm);
		services.stub(ICodeIndexService, upcastPartial<ICodeIndexService>({
			status: async () => ({ state: options?.indexState ?? CodeIndexState.Disabled, files: 0, chunks: 0 }),
			search: async () => options?.indexHits ?? [],
		}));

		const provider = store.add(
			services.createInstance(MyTraeInlineCompletionProvider),
		);
		const model = store.add(
			createTextModel('console.lo', 'typescript', {}, URI.file('/workspace/app.ts')),
		);
		return { provider, model, chatCalls, configuration };
	}

	async function provide(
		provider: MyTraeInlineCompletionProvider,
		model: ITextModel,
		position: Position,
		context?: InlineCompletionContext,
	): Promise<string | undefined> {
		const result = await provider.provideInlineCompletions(
			model,
			position,
			context ?? completionContext(),
			CancellationToken.None,
		);
		const item = result?.items[0];
		return typeof item?.insertText === 'string' ? item.insertText : undefined;
	}

	test('returns a suggestion and routes it as a completion request', async () => {
		const { provider, model, chatCalls } = setup();
		const insertText = await provide(provider, model, new Position(1, 11));

		assert.strictEqual(insertText, 'g("hi");');
		assert.strictEqual(chatCalls.length, 1);
		assert.strictEqual(chatCalls[0].purpose, AIRequestPurpose.Completion);
		assert.strictEqual(chatCalls[0].maxTokens, 160);
		assert.strictEqual(chatCalls[0].messages[0].role, 'system');
		assert.ok(chatCalls[0].messages[1].content.includes('console.lo<cursor>'));
	});

	test('serves repeated requests from the cache', async () => {
		const { provider, model, chatCalls } = setup();
		const first = await provide(provider, model, new Position(1, 11));
		const second = await provide(provider, model, new Position(1, 11));

		assert.strictEqual(first, 'g("hi");');
		assert.strictEqual(second, first);
		assert.strictEqual(chatCalls.length, 1);
	});

	test('serves the remainder while the suggestion is being typed', async () => {
		const { provider, model, chatCalls } = setup();
		await provide(provider, model, new Position(1, 11));

		model.setValue('console.log');
		const insertText = await provide(provider, model, new Position(1, 12));

		assert.strictEqual(insertText, '("hi");');
		assert.strictEqual(chatCalls.length, 1);
	});

	test('does nothing when completion is disabled', async () => {
		const { provider, model, chatCalls } = setup({
			settings: { myTrae: { completion: { enabled: false } } },
		});
		assert.strictEqual(await provide(provider, model, new Position(1, 11)), undefined);
		assert.strictEqual(chatCalls.length, 0);
	});

	test('does nothing when the provider is not configured', async () => {
		const { provider, model, chatCalls } = setup({ configured: false });
		assert.strictEqual(await provide(provider, model, new Position(1, 11)), undefined);
		assert.strictEqual(chatCalls.length, 0);
	});

	test('yields to the suggest widget', async () => {
		const { provider, model, chatCalls } = setup();
		const context = completionContext({
			selectedSuggestionInfo: new SelectedSuggestionInfo(
				new Range(1, 1, 1, 11),
				'console',
				CompletionItemKind.Text,
				false,
			),
		});
		assert.strictEqual(await provide(provider, model, new Position(1, 11), context), undefined);
		assert.strictEqual(chatCalls.length, 0);
	});

	test('drops empty answers instead of caching them', async () => {
		const { provider, model, chatCalls } = setup({ response: '   ' });
		assert.strictEqual(await provide(provider, model, new Position(1, 11)), undefined);
		assert.strictEqual(await provide(provider, model, new Position(1, 11)), undefined);
		assert.strictEqual(chatCalls.length, 2);
	});

	test('cancelled requests are not cached', async () => {
		const { provider, model, chatCalls } = setup();
		const cts = new CancellationTokenSource();
		const pending = provider.provideInlineCompletions(
			model,
			new Position(1, 11),
			completionContext(),
			cts.token,
		);
		cts.cancel();
		assert.strictEqual((await pending)?.items[0]?.insertText, undefined);

		const again = await provide(provider, model, new Position(1, 11));
		assert.strictEqual(again, 'g("hi");');
		// Cancellation lands before the model call is issued, so only the retry reaches it.
		assert.strictEqual(chatCalls.length, 1);
	});

	test('debounce delay follows the configuration', async () => {
		const { provider, configuration } = setup();
		assert.strictEqual(provider.debounceDelayMs, 300);
		await configuration.setUserConfiguration('myTrae.completion.debounceMs', 123);
		assert.strictEqual(provider.debounceDelayMs, 123);
	});
});
