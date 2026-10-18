/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import {
	InlineCompletion,
	InlineCompletionContext,
	InlineCompletions,
	InlineCompletionsProvider,
} from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { localize } from '../../../../nls.js';
import {
	AIRequestPurpose,
	ILLMService,
} from '../../../../platform/ai/common/ai.js';
import { readAIConfiguration } from '../../../../platform/ai/common/aiConfiguration.js';
import { CodeIndexState, ICodeIndexHit, ICodeIndexService } from '../../../../platform/ai/common/codeIndex.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IWorkbenchContribution,
	WorkbenchPhase,
	registerWorkbenchContribution2,
} from '../../../common/contributions.js';
import { COMPLETION_SYSTEM_PROMPT } from '../common/prompts.js';

/**
 * Inline completion backed by the configured LLM. The provider stays deliberately thin:
 * ghost text rendering, Tab acceptance, debounce and stale request cancellation are all
 * owned by the editor inline completion infrastructure. This class only assembles the
 * document context, calls the model and post-processes the answer.
 */

const MAX_COMPLETION_TOKENS = 160;
/** Minimum suffix overlap length before repeated text after the cursor is trimmed. */
const MIN_SUFFIX_OVERLAP = 4;
const MAX_CACHE_ENTRIES = 50;

/** Hard budget for index retrieval so ghost text latency never regresses visibly. */
const INDEX_RETRIEVAL_BUDGET_MS = 350;
const INDEX_CACHE_TTL_MS = 120000;
const INDEX_NEGATIVE_TTL_MS = 15000;
const INDEX_CACHE_MAX = 24;
const MAX_REFERENCE_CHARS = 800;
const MAX_REFERENCES = 2;

export interface ICompletionContextOptions {
	readonly maxPrefixLines: number;
	readonly maxSuffixLines: number;
	readonly maxPrefixChars: number;
	readonly maxSuffixChars: number;
}

export const DEFAULT_COMPLETION_CONTEXT_OPTIONS: ICompletionContextOptions = {
	maxPrefixLines: 60,
	maxSuffixLines: 20,
	maxPrefixChars: 4000,
	maxSuffixChars: 1500,
};

export interface ICompletionDocumentContext {
	/** Text before the cursor, capped to the configured line/char budget. */
	readonly prefix: string;
	/** Text after the cursor, capped to the configured line/char budget. */
	readonly suffix: string;
	/** Current line before the cursor. Cache key component. */
	readonly linePrefix: string;
	/** Current line after the cursor. Used to trim repeated text. */
	readonly lineSuffix: string;
	readonly languageId: string;
	readonly fileName: string;
}

/** Collects the text around the cursor within the given budget. Pure, unit tested. */
export function assembleCompletionContext(
	model: ITextModel,
	position: Position,
	options: ICompletionContextOptions = DEFAULT_COMPLETION_CONTEXT_OPTIONS,
): ICompletionDocumentContext {
	const lineNumber = position.lineNumber;
	const lineContent = model.getLineContent(lineNumber);
	const linePrefix = lineContent.slice(0, position.column - 1);
	const lineSuffix = lineContent.slice(position.column - 1);

	const firstPrefixLine = Math.max(1, lineNumber - options.maxPrefixLines);
	const prefixParts: string[] = [];
	for (let line = firstPrefixLine; line < lineNumber; line++) {
		prefixParts.push(model.getLineContent(line));
	}
	prefixParts.push(linePrefix);
	let prefix = prefixParts.join('\n');
	if (prefix.length > options.maxPrefixChars) {
		prefix = prefix.slice(prefix.length - options.maxPrefixChars);
	}

	const lastSuffixLine = Math.min(
		model.getLineCount(),
		lineNumber + options.maxSuffixLines,
	);
	const suffixParts: string[] = [lineSuffix];
	for (let line = lineNumber + 1; line <= lastSuffixLine; line++) {
		suffixParts.push(model.getLineContent(line));
	}
	let suffix = suffixParts.join('\n');
	if (suffix.length > options.maxSuffixChars) {
		suffix = suffix.slice(0, options.maxSuffixChars);
	}

	const path = model.uri.path;
	return {
		prefix,
		suffix,
		linePrefix,
		lineSuffix,
		languageId: model.getLanguageId(),
		fileName: path.slice(path.lastIndexOf('/') + 1) || model.uri.toString(),
	};
}

/** Prompt sent as the single user message. Markers stay out of generated code. */
export function buildCompletionPrompt(
	context: ICompletionDocumentContext,
	references: readonly { path: string; text: string }[] = [],
): string {
	const lines = [
		`Complete the ${context.languageId} code in \`${context.fileName}\`. The cursor is at <cursor>. Reply with only the code that belongs at <cursor>: no explanation, no markdown fences, and do not repeat the code before or after <cursor>.`,
	];
	for (const reference of references) {
		lines.push(
			'',
			`Related code from ${reference.path} of this workspace (context only, do not repeat it):`,
			'```',
			reference.text,
			'```',
		);
	}
	lines.push('', '```' + context.languageId, `${context.prefix}<cursor>${context.suffix}`, '```');
	return lines.join('\n');
}

/**
 * Cleans raw model output into insertable text. Returns `undefined` when nothing usable
 * remains (empty answer or a plain repetition of the text already after the cursor).
 *
 * Chat models tend to echo the line prefix back (`const f = fibo` -> `const f = fibonacci;`).
 * That echo has to go: the inline completion engine only shows suggestions whose insert
 * text continues what is already typed, and a repeated prefix would produce garbage.
 */
export function sanitizeCompletion(
	raw: string,
	lineSuffix: string,
	linePrefix: string = '',
): string | undefined {
	let text = raw;

	// Chat models sometimes wrap the answer in fences despite being told not to.
	const fenced = text.match(/^```[a-zA-Z0-9+#.-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
	if (fenced) {
		text = fenced[1];
	} else if (text.startsWith('```')) {
		const newline = text.indexOf('\n');
		text = newline === -1 ? '' : text.slice(newline + 1);
		if (text.endsWith('```')) {
			text = text.slice(0, text.length - 3);
		}
	}

	text = text.replace(/<cursor>/g, '');

	// Strip an echoed prefix before looking at suffix repetition.
	const echo = prefixEchoLength(text, linePrefix);
	if (echo > 0) {
		text = text.slice(echo);
	}

	// The model may continue past the cursor and repeat text that already follows it.
	const overlap = suffixOverlapLength(text, lineSuffix);
	if (overlap > 0) {
		text = text.slice(0, text.length - overlap);
	}

	text = text.replace(/\s+$/g, '');
	if (text.length === 0) {
		return undefined;
	}
	// Pure repetition of what is already there is not a suggestion.
	if (lineSuffix.trim().length > 0 && text === lineSuffix.trim()) {
		return undefined;
	}
	return text;
}

/**
 * Length of the longest head of `text` that duplicates the tail of `linePrefix`
 * (the model echoing what the user already typed).
 */
function prefixEchoLength(text: string, linePrefix: string): number {
	const max = Math.min(text.length, linePrefix.length, 500);
	for (let length = max; length >= 1; length--) {
		if (text.startsWith(linePrefix.slice(linePrefix.length - length))) {
			return length;
		}
	}
	return 0;
}

/**
 * Length of the longest tail of `text` that duplicates the head of `lineSuffix`.
 * Trivial matches below {@link MIN_SUFFIX_OVERLAP} are ignored so that legitimately
 * repeated characters (brackets, semicolons) survive.
 */
function suffixOverlapLength(text: string, lineSuffix: string): number {
	const max = Math.min(text.length, lineSuffix.length, 200);
	for (let length = max; length >= MIN_SUFFIX_OVERLAP; length--) {
		if (text.endsWith(lineSuffix.slice(0, length))) {
			return length;
		}
	}
	return 0;
}

interface ICompletionCacheEntry {
	readonly uri: string;
	readonly lineNumber: number;
	readonly linePrefix: string;
	readonly insertText: string;
}

/**
 * Small LRU over recent suggestions. Besides exact hits it serves "forward" hits: when
 * the user keeps typing the shown suggestion, the remainder is returned instantly
 * instead of issuing another request.
 */
export class CompletionCache {
	private entries: ICompletionCacheEntry[] = [];

	get(uri: string, lineNumber: number, linePrefix: string): string | undefined {
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (entry.uri !== uri || entry.lineNumber !== lineNumber) {
				continue;
			}
			let insertText: string | undefined;
			if (entry.linePrefix === linePrefix) {
				insertText = entry.insertText;
			} else if (linePrefix.startsWith(entry.linePrefix)) {
				const typed = linePrefix.slice(entry.linePrefix.length);
				if (typed.length > 0 && entry.insertText.startsWith(typed)) {
					insertText = entry.insertText.slice(typed.length);
				}
			}
			if (insertText !== undefined && insertText.length > 0) {
				this.entries.splice(i, 1);
				this.entries.unshift(entry);
				return insertText;
			}
		}
		return undefined;
	}

	set(
		uri: string,
		lineNumber: number,
		linePrefix: string,
		insertText: string,
	): void {
		if (insertText.length === 0) {
			return;
		}
		this.entries = this.entries.filter(
			(entry) =>
				!(
					entry.uri === uri &&
					entry.lineNumber === lineNumber &&
					entry.linePrefix === linePrefix
				),
		);
		this.entries.unshift({ uri, lineNumber, linePrefix, insertText });
		if (this.entries.length > MAX_CACHE_ENTRIES) {
			this.entries.length = MAX_CACHE_ENTRIES;
		}
	}

	clear(): void {
		this.entries = [];
	}
}

export class MyTraeInlineCompletionProvider
	extends Disposable
	implements InlineCompletionsProvider {
	readonly groupId = 'myTrae';
	readonly displayName = localize(
		'myTrae.completion.displayName',
		"MyTrae AI",
	);

	private readonly cache = new CompletionCache();
	private readonly referenceCache = new Map<string, { references: { path: string; text: string }[]; at: number }>();

	constructor(
		@ILLMService private readonly llmService: ILLMService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@ICodeIndexService
		private readonly indexService: ICodeIndexService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Read per fetch by the editor debounce logic, so config changes apply live. */
	get debounceDelayMs(): number {
		return readAIConfiguration(this.configurationService)
			.completionDebounceMs;
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions | undefined> {
		const configuration = readAIConfiguration(this.configurationService);
		if (!configuration.completionEnabled) {
			return undefined;
		}
		// Never compete with the suggest widget for the same keystroke.
		if (context.selectedSuggestionInfo) {
			return undefined;
		}
		if (!this.llmService.isConfigured(AIRequestPurpose.Completion)) {
			return undefined;
		}

		const documentContext = assembleCompletionContext(model, position, {
			...DEFAULT_COMPLETION_CONTEXT_OPTIONS,
			maxPrefixLines: configuration.completionMaxPrefixLines,
		});
		const uri = model.uri.toString();

		const cached = this.cache.get(
			uri,
			position.lineNumber,
			documentContext.linePrefix,
		);
		if (cached !== undefined) {
			return { items: [toInlineCompletion(cached, position)] };
		}

		const controller = new AbortController();
		const cancellationListener = token.onCancellationRequested(() =>
			controller.abort(),
		);
		const startedAt = Date.now();
		try {
			const references = await this.retrieveReferences(documentContext, uri, token);
			const response = await this.llmService.chat(
				{
					purpose: AIRequestPurpose.Completion,
					messages: [
						{ role: 'system', content: COMPLETION_SYSTEM_PROMPT },
						{
							role: 'user',
							content: buildCompletionPrompt(documentContext, references),
						},
					],
					maxTokens: MAX_COMPLETION_TOKENS,
				},
				controller.signal,
			);
			if (token.isCancellationRequested) {
				return undefined;
			}

			this.logService.trace(
				`[ai] inline completion raw (${response.content.length} chars): ${response.content.slice(0, 200).replace(/\r?\n/g, '\\n')}`,
			);
			const insertText = sanitizeCompletion(
				response.content,
				documentContext.lineSuffix,
				documentContext.linePrefix,
			);
			if (insertText === undefined) {
				this.logService.trace('[ai] inline completion rejected by sanitize');
				return undefined;
			}

			this.cache.set(
				uri,
				position.lineNumber,
				documentContext.linePrefix,
				insertText,
			);
			return { items: [toInlineCompletion(insertText, position)] };
		} catch (error) {
			if (!controller.signal.aborted) {
				this.logService.warn(
					`[ai] inline completion failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return undefined;
		} finally {
			cancellationListener.dispose();
			this.logService.trace(
				`[ai] inline completion request took ${Date.now() - startedAt}ms`,
			);
		}
	}

	/**
	 * Cross-file context from the workspace index, keyed by the prefix tail. Strictly
	 * time-budgeted and negatively cached so a cold index can never stall typing.
	 */
	private async retrieveReferences(
		documentContext: ICompletionDocumentContext,
		uri: string,
		token: CancellationToken,
	): Promise<{ path: string; text: string }[]> {
		const tail = documentContext.prefix.slice(-300);
		const key = `${uri}:${tail}`;
		const cached = this.referenceCache.get(key);
		const now = Date.now();
		if (cached && now - cached.at < (cached.references.length > 0 ? INDEX_CACHE_TTL_MS : INDEX_NEGATIVE_TTL_MS)) {
			return cached.references;
		}
		try {
			const status = await this.indexService.status();
			if (status.state !== CodeIndexState.Ready && status.state !== CodeIndexState.Indexing) {
				this.rememberReferences(key, []);
				return [];
			}
			const search = this.indexService
				.search({ text: documentContext.prefix.slice(-800), maxResults: MAX_REFERENCES })
				.catch(() => [] as ICodeIndexHit[]);
			const budget = timeout(INDEX_RETRIEVAL_BUDGET_MS).then(() => [] as ICodeIndexHit[]);
			const hits = await Promise.race([search, budget]);
			// Only the current file is uninteresting; drop hits from the same document.
			const references = hits
				.filter(hit => !uri.endsWith(`/${hit.path}`))
				.slice(0, MAX_REFERENCES)
				.map(hit => ({ path: hit.path, text: hit.text.slice(0, MAX_REFERENCE_CHARS) }));
			this.rememberReferences(key, references);
			return references;
		} catch {
			this.rememberReferences(key, []);
			return [];
		} finally {
			if (token.isCancellationRequested) {
				// The keystroke moved on; do not let a stale entry pin the cache.
				this.referenceCache.delete(key);
			}
		}
	}

	private rememberReferences(key: string, references: { path: string; text: string }[]): void {
		this.referenceCache.delete(key);
		this.referenceCache.set(key, { references, at: Date.now() });
		while (this.referenceCache.size > INDEX_CACHE_MAX) {
			const oldest = this.referenceCache.keys().next();
			if (oldest.done) {
				break;
			}
			this.referenceCache.delete(oldest.value);
		}
	}

	disposeInlineCompletions(): void {
		// Stateless apart from the cache, which outlives individual suggestion lists.
	}

	override dispose(): void {
		this.cache.clear();
		this.referenceCache.clear();
		super.dispose();
	}
}

function toInlineCompletion(insertText: string, position: Position): InlineCompletion {
	// Pure insertion at the cursor. The default word-replacement range would hide
	// the suggestion whenever the continuation does not start with the typed word.
	return {
		insertText,
		range: new Range(
			position.lineNumber,
			position.column,
			position.lineNumber,
			position.column,
		),
	};
}

class MyTraeInlineCompletionContribution
	extends Disposable
	implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.myTraeInlineCompletion';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		const provider = this._register(
			instantiationService.createInstance(MyTraeInlineCompletionProvider),
		);
		this._register(
			languageFeaturesService.inlineCompletionsProvider.register(
				'*',
				provider,
			),
		);
	}
}

registerWorkbenchContribution2(
	MyTraeInlineCompletionContribution.ID,
	MyTraeInlineCompletionContribution,
	WorkbenchPhase.AfterRestored,
);
