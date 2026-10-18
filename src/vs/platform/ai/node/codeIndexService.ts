/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { watch, type FSWatcher } from 'fs';
import { lstat, readdir, readFile } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import { timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { StopWatch } from '../../../base/common/stopwatch.js';
import { chunkSourceCode } from '../common/codeChunker.js';
import { CodeIndexState, ICodeIndexConfiguration, ICodeIndexHit, ICodeIndexQuery, ICodeIndexStatus } from '../common/codeIndex.js';
import { CodeIndexStore, fromBlob, IChunkRow, IStoredChunk, normalize } from './codeIndexStore.js';
import { ALWAYS_IGNORED, IIgnoreRule, isIgnored, parseGitignore } from './gitignore.js';

/**
 * Workspace indexer (M5). Walks the first workspace folder, chunks sources at
 * declaration boundaries, embeds them through the configured OpenAI-compatible
 * endpoint and persists everything into a single sqlite file. Retrieval fuses
 * vector similarity, BM25 and path matching with reciprocal rank fusion. All work
 * happens in the indexer utility process; the renderer only sees status events.
 */

const MAX_FILE_BYTES = 512 * 1024;
/** Embedding input is capped: code signal concentrates at the declaration head, and
 * short inputs cut the local embedding cost of long chunks roughly threefold. */
const EMBED_INPUT_MAX_CHARS = 1200;
const DEFAULT_MAX_FILES = 3000;
/* Measured against a local bge-m3 endpoint (~47 chunks/s at the 1200 char input cap):
 * 12000 chunks keeps the first full build of a large workspace under the 5 minute
 * acceptance budget. The caps are a safety valve, not a quality statement. */
const DEFAULT_MAX_CHUNKS = 12000;
const DEFAULT_BATCH_SIZE = 64;
const WATCH_DEBOUNCE_MS = 500;
const EMBED_TIMEOUT_MS = 120000;
const EMBED_ATTEMPTS = 3;

const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz', '.tar', '.br', '.7z', '.rar', '.dylib', '.so', '.dll', '.exe', '.bin', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac', '.ogg', '.dsym', '.plist', '.lockb',
]);

const LANGUAGE_BY_EXTENSION = new Map([
	['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'], ['.tsx', 'typescriptreact'],
	['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.jsx', 'javascriptreact'],
	['.json', 'json'], ['.css', 'css'], ['.scss', 'scss'], ['.less', 'less'],
	['.py', 'python'], ['.c', 'c'], ['.h', 'c'], ['.cpp', 'cpp'], ['.hpp', 'cpp'], ['.cs', 'csharp'],
	['.go', 'go'], ['.java', 'java'], ['.rs', 'rust'], ['.swift', 'swift'], ['.kt', 'kotlin'], ['.php', 'php'],
]);

interface IDiscoveredFile {
	readonly path: string;
	readonly key: string;
}

interface IEmbeddedFile {
	readonly path: string;
	readonly key: string;
	readonly chunks: IStoredChunk[];
}

interface IBM25Index {
	readonly postings: Map<string, Map<number, number>>;
	readonly lengths: number[];
	readonly keys: string[];
	readonly paths: Map<string, string>;
	readonly total: number;
	readonly averageLength: number;
}

export class CodeIndexService extends Disposable {
	private readonly _onDidChangeStatus = this._register(new Emitter<ICodeIndexStatus>());
	readonly onDidChangeStatus: Event<ICodeIndexStatus> = this._onDidChangeStatus.event;

	private configuration: ICodeIndexConfiguration | undefined;
	private store: CodeIndexStore | undefined;
	private watcher: FSWatcher | undefined;
	private readonly watcherDisposables = this._register(new DisposableStore());
	private generation = 0;
	private syncPromise: Promise<void> | undefined;
	private currentStatus: ICodeIndexStatus = { state: CodeIndexState.Uninitialized, files: 0, chunks: 0 };

	getStatus(): ICodeIndexStatus {
		return this.currentStatus;
	}

	async initialize(configuration: ICodeIndexConfiguration): Promise<ICodeIndexStatus> {
		this.stopWorkerWork();
		const generation = ++this.generation;
		if (this.isSameConfiguration(configuration) && this.store) {
			// Same workspace and model: keep the persisted index and just resync.
			this.startSync(generation, false);
			return this.currentStatus;
		}
		this.configuration = configuration;
		this.store?.close();
		this.store = undefined;
		try {
			this.store = CodeIndexStore.open(configuration.storageDir);
		} catch (error) {
			return this.setError(generation, error);
		}
		const previousModel = this.store.meta('embeddingModel');
		if (previousModel && previousModel !== configuration.embedding.model) {
			this.store.clear();
		}
		this.store.setMeta('embeddingModel', configuration.embedding.model);
		this.startWatcher();
		this.startSync(generation, false);
		return this.currentStatus;
	}

	async reindex(): Promise<ICodeIndexStatus> {
		this.stopWorkerWork();
		const generation = ++this.generation;
		if (!this.configuration || !this.store) {
			return this.currentStatus;
		}
		this.store.clear();
		this.store.setMeta('embeddingModel', this.configuration.embedding.model);
		this.bm25Dirty = true;
		this.startSync(generation, true);
		return this.currentStatus;
	}

	async status(): Promise<ICodeIndexStatus> {
		return this.currentStatus;
	}

	async search(query: ICodeIndexQuery): Promise<readonly ICodeIndexHit[]> {
		const text = query.text.trim();
		const maxResults = Math.max(1, Math.min(50, query.maxResults ?? 8));
		if (!text || !this.store || !this.configuration) {
			return [];
		}
		const vectors = await this.embed([text.slice(0, 4000)]);
		const queryVector = normalize(vectors[0]);

		const vectorRanking = this.rankByVector(queryVector, maxResults * 6);
		const lexicalRanking = this.rankByBM25(text, maxResults * 6);
		const pathRanking = this.rankByPath(text, maxResults * 6);
		return this.fuse([vectorRanking, lexicalRanking, pathRanking], maxResults);
	}

	// --- indexing pipeline ---

	private startSync(generation: number, force: boolean): void {
		this.syncPromise = this.sync(generation, force).catch(error => {
			if (generation === this.generation) {
				this.setError(generation, error);
			}
		}).finally(() => {
			if (generation === this.generation) {
				this.syncPromise = undefined;
			}
		});
	}

	private async sync(generation: number, force: boolean): Promise<void> {
		const store = this.store;
		const configuration = this.configuration;
		if (!store || !configuration) {
			return;
		}
		const stopWatch = StopWatch.create();
		const discovered = await this.scan();
		if (generation !== this.generation) {
			return;
		}
		const known = new Map(store.paths().map(record => [record.path, record]));
		const stale = force ? [...known.keys()] : undefined;
		const pending: IDiscoveredFile[] = [];
		for (const file of discovered) {
			const record = known.get(file.path);
			if (force || record?.key !== file.key) {
				pending.push(file);
			}
		}
		const limits = this.limits();
		const totalChunks = store.counts().chunks;
		let indexedChunks = totalChunks;
		let indexed = 0;
		const removed = stale ?? [...known.keys()].filter(path => !discovered.some(file => file.path === path));
		for (const path of removed) {
			store.deleteFile(path);
			this.bm25Dirty = true;
		}

		this.setStatus(generation, {
			state: CodeIndexState.Indexing,
			...store.counts(),
			totalFiles: pending.length,
			indexedFiles: 0,
			embeddingModel: configuration.embedding.model,
		});

		// Embed small files together, one request per batch, then persist per file.
		let queue = pending;
		while (queue.length > 0) {
			if (generation !== this.generation) {
				return;
			}
			if (indexedChunks >= limits.maxChunks || indexed >= limits.maxFiles) {
				this.log(`index truncated at ${indexed} files / ${indexedChunks} chunks`);
				break;
			}
			const batch: IEmbeddedFile[] = [];
			let size = 0;
			const rest: IDiscoveredFile[] = [];
			for (const file of queue) {
				if (batch.length > 0 && size >= limits.batchSize) {
					rest.push(file);
					continue;
				}
				const chunks = await this.chunkFile(file.path);
				if (chunks.length === 0) {
					if (known.has(file.path)) { store.deleteFile(file.path); }
					continue;
				}
				if (indexedChunks + chunks.length > limits.maxChunks) {
					continue;
				}
				batch.push({ ...file, chunks });
				size += chunks.length;
				indexedChunks += chunks.length;
			}
			queue = rest;
			if (batch.length === 0) {
				break;
			}
			const vectors = await this.embed(batch.flatMap(file => file.chunks.map(chunk => chunk.text.slice(0, EMBED_INPUT_MAX_CHARS))));
			if (generation !== this.generation) {
				return;
			}
			let offset = 0;
			for (const file of batch) {
				const fileVectors = vectors.slice(offset, offset + file.chunks.length);
				offset += file.chunks.length;
				store.upsertFile(file.path, file.key, file.chunks.map((chunk, index) => ({ ...chunk, vector: normalize(fileVectors[index]) })));
				this.bm25Dirty = true;
				indexed++;
			}
			this.setStatus(generation, {
				state: CodeIndexState.Indexing,
				...store.counts(),
				totalFiles: pending.length,
				indexedFiles: indexed,
				embeddingModel: configuration.embedding.model,
			});
		}
		const dimension = this.store ? vectors0(this.store) : 0;
		if (this.store && dimension > 0) {
			this.store.setMeta('dimension', String(dimension));
		}
		this.setStatus(generation, {
			state: CodeIndexState.Ready,
			...store.counts(),
			embeddingModel: configuration.embedding.model,
			dimension: dimension > 0 ? dimension : undefined,
		});
		this.log(`index sync completed in ${Math.round(stopWatch.elapsed())}ms`);
	}

	private async scan(): Promise<IDiscoveredFile[]> {
		const configuration = this.configuration;
		if (!configuration) {
			return [];
		}
		const root = configuration.workspaceRoot;
		const files: IDiscoveredFile[] = [];
		const limits = this.limits();
		const visit = async (absoluteDirectory: string, relativeDirectory: string, rules: readonly IIgnoreRule[]): Promise<void> => {
			if (files.length >= limits.maxFiles) {
				return;
			}
			let entries: string[];
			let localRules = rules;
			try {
				entries = await readdir(absoluteDirectory);
				const gitignore = entries.includes('.gitignore') ? parseGitignore(await readFile(join(absoluteDirectory, '.gitignore'), 'utf8'), relativeDirectory) : [];
				localRules = gitignore.length > 0 ? [...rules, ...gitignore] : rules;
			} catch {
				return;
			}
			for (const name of entries) {
				if (ALWAYS_IGNORED.has(name)) {
					continue;
				}
				const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
				const absolute = join(absoluteDirectory, name);
				let stats;
				try {
					stats = await lstat(absolute);
				} catch {
					continue;
				}
				if (stats.isSymbolicLink()) {
					continue;
				}
				if (stats.isDirectory()) {
					if (!isIgnored(relativePath, true, localRules)) {
						await visit(absolute, relativePath, localRules);
					}
					continue;
				}
				if (!stats.isFile() || files.length >= limits.maxFiles) {
					continue;
				}
				if (stats.size === 0 || stats.size > MAX_FILE_BYTES || BINARY_EXTENSIONS.has(extensionOf(name))) {
					continue;
				}
				if (isIgnored(relativePath, false, localRules)) {
					continue;
				}
				if (!LANGUAGE_BY_EXTENSION.has(extensionOf(name))) {
					continue;
				}
				files.push({ path: relativePath, key: `${stats.size}:${Math.floor(stats.mtimeMs)}` });
			}
		};
		await visit(root, '', []);
		return files;
	}

	private async chunkFile(relativePath: string): Promise<IStoredChunk[]> {
		const configuration = this.configuration;
		if (!configuration) {
			return [];
		}
		let text: string;
		try {
			const buffer = await readFile(join(configuration.workspaceRoot, relativePath));
			if (buffer.subarray(0, 8192).includes(0)) {
				return [];
			}
			text = buffer.toString('utf8');
		} catch {
			return [];
		}
		return chunkSourceCode(text, LANGUAGE_BY_EXTENSION.get(extensionOf(relativePath)) ?? 'plaintext').map(chunk => ({
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			text: chunk.text,
			vector: new Float32Array(0),
		}));
	}

	// --- embedding ---

	private async embed(inputs: readonly string[]): Promise<Float32Array[]> {
		const configuration = this.configuration;
		if (!configuration || inputs.length === 0) {
			return [];
		}
		const url = `${configuration.embedding.baseUrl.replace(/\/+$/, '')}/embeddings`;
		let lastError: unknown;
		for (let attempt = 0; attempt < EMBED_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				await timeout(500 * Math.pow(2, attempt - 1));
			}
			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${configuration.embedding.apiKey || 'not-needed'}`,
					},
					body: JSON.stringify({ model: configuration.embedding.model, input: inputs }),
					signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
				});
				if (!response.ok) {
					throw new Error(`embedding endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
				}
				const payload = await response.json() as { data?: { index?: number; embedding: number[] }[] };
				const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
				if (data.length !== inputs.length) {
					throw new Error(`embedding endpoint returned ${data.length} vectors for ${inputs.length} inputs`);
				}
				const vectors = data.map(entry => new Float32Array(entry.embedding));
				validateDimensions(vectors);
				return vectors;
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(`embedding request failed after ${EMBED_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
	}

	// --- retrieval ---

	private rankByVector(queryVector: Float32Array, limit: number): { key: string; score: number }[] {
		const store = this.store;
		if (!store || queryVector.length === 0) {
			return [];
		}
		const scores: { key: string; score: number }[] = [];
		for (const row of store.chunksByVector()) {
			const vector = fromBlob(row.vector);
			if (vector.length !== queryVector.length) {
				continue;
			}
			let dot = 0;
			for (let i = 0; i < vector.length; i++) {
				dot += vector[i] * queryVector[i];
			}
			pushTop(scores, { key: `${row.path}:${row.start_line}`, score: dot }, limit);
		}
		scores.sort((a, b) => b.score - a.score);
		return scores.slice(0, limit);
	}

	private rankByBM25(query: string, limit: number): { key: string; score: number }[] {
		const index = this.bm25();
		if (!index) {
			return [];
		}
		const terms = tokenize(query);
		const scores = new Map<number, number>();
		for (const term of terms) {
			const postings = index.postings.get(term);
			if (!postings) {
				continue;
			}
			const idf = Math.log(1 + (index.total - postings.size + 0.5) / (postings.size + 0.5));
			for (const [doc, tf] of postings) {
				const norm = (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (index.lengths[doc] / index.averageLength)));
				scores.set(doc, (scores.get(doc) ?? 0) + idf * norm);
			}
		}
		const ranked = [...scores.entries()].map(([doc, score]) => ({ key: index.keys[doc], score }));
		ranked.sort((a, b) => b.score - a.score);
		return ranked.slice(0, limit);
	}

	private rankByPath(query: string, limit: number): { key: string; score: number }[] {
		const index = this.bm25();
		if (!index) {
			return [];
		}
		const tokens = tokenize(query);
		const scores: { key: string; score: number }[] = [];
		for (const [key, path] of index.paths) {
			const segments = path.toLowerCase().split(/[^a-z0-9]+/);
			let score = 0;
			for (const token of tokens) {
				if (token.length >= 3 && segments.includes(token)) {
					score += 1;
				}
			}
			if (score > 0) {
				pushTop(scores, { key, score }, limit);
			}
		}
		scores.sort((a, b) => b.score - a.score);
		return scores.slice(0, limit);
	}

	/** Reciprocal rank fusion over the three rankings. */
	private fuse(rankings: readonly { key: string; score: number }[][], maxResults: number): ICodeIndexHit[] {
		const store = this.store;
		if (!store) {
			return [];
		}
		const fused = new Map<string, number>();
		for (const ranking of rankings) {
			for (const [position, entry] of ranking.entries()) {
				fused.set(entry.key, (fused.get(entry.key) ?? 0) + 1 / (60 + position + 1));
			}
		}
		const winners = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxResults);
		const rowsByKey = new Map<string, IChunkRow>();
		for (const row of store.chunksByVector()) {
			rowsByKey.set(`${row.path}:${row.start_line}`, row);
		}
		const hits: ICodeIndexHit[] = [];
		for (const [key, score] of winners) {
			const row = rowsByKey.get(key);
			if (row) {
				hits.push({ path: row.path, startLine: row.start_line, endLine: row.end_line, text: row.text, score });
			}
		}
		return hits;
	}

	// --- BM25 state ---

	private bm25Dirty = true;
	private bm25Index: IBM25Index | undefined;

	private bm25(): IBM25Index | undefined {
		if (!this.bm25Dirty && this.bm25Index) {
			return this.bm25Index;
		}
		const store = this.store;
		if (!store) {
			return undefined;
		}
		const postings = new Map<string, Map<number, number>>();
		const lengths: number[] = [];
		const keys: string[] = [];
		const paths = new Map<string, string>();
		let totalTokens = 0;
		for (const row of store.chunksByVector()) {
			const doc = keys.length;
			const tokens = tokenize(row.text);
			keys.push(`${row.path}:${row.start_line}`);
			paths.set(`${row.path}:${row.start_line}`, row.path);
			lengths.push(tokens.length);
			totalTokens += tokens.length;
			for (let i = 0; i < tokens.length; i++) {
				let docTf = postings.get(tokens[i]);
				if (!docTf) {
					docTf = new Map();
					postings.set(tokens[i], docTf);
				}
				docTf.set(doc, (docTf.get(doc) ?? 0) + 1);
			}
		}
		this.bm25Index = {
			postings,
			lengths,
			keys,
			paths,
			total: keys.length,
			averageLength: keys.length > 0 ? totalTokens / keys.length : 1,
		};
		this.bm25Dirty = false;
		return this.bm25Index;
	}

	// --- lifecycle helpers ---

	private startWatcher(): void {
		this.watcherDisposables.clear();
		this.watcher?.close();
		this.watcher = undefined;
		const configuration = this.configuration;
		if (!configuration) {
			return;
		}
		try {
			this.watcher = watch(configuration.workspaceRoot, { recursive: true }, () => {
				const generation = this.generation;
				setTimeout(() => {
					if (generation === this.generation && !this.syncPromise) {
						this.startSync(generation, false);
					}
				}, WATCH_DEBOUNCE_MS);
			});
			this.watcherDisposables.add(toDisposable(() => this.watcher?.close()));
		} catch (error) {
			this.log(`fs.watch unavailable, index will not auto-refresh: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private stopWorkerWork(): void {
		this.generation++;
		this.syncPromise = undefined;
		this.watcherDisposables.clear();
		this.watcher?.close();
		this.watcher = undefined;
	}

	private isSameConfiguration(configuration: ICodeIndexConfiguration): boolean {
		const previous = this.configuration;
		return !!previous
			&& previous.workspaceRoot === configuration.workspaceRoot
			&& previous.embedding.baseUrl === configuration.embedding.baseUrl
			&& previous.embedding.model === configuration.embedding.model;
	}

	private limits(): { maxFiles: number; maxChunks: number; batchSize: number } {
		return {
			maxFiles: this.configuration?.maxFiles ?? DEFAULT_MAX_FILES,
			maxChunks: this.configuration?.maxChunks ?? DEFAULT_MAX_CHUNKS,
			batchSize: this.configuration?.batchSize ?? DEFAULT_BATCH_SIZE,
		};
	}

	private setStatus(generation: number, status: ICodeIndexStatus): void {
		if (generation !== this.generation) {
			return;
		}
		this.currentStatus = status;
		this._onDidChangeStatus.fire(status);
	}

	private setError(generation: number, error: unknown): ICodeIndexStatus {
		const message = error instanceof Error ? error.message : String(error);
		this.log(`index error: ${message}`);
		this.setStatus(generation, { state: CodeIndexState.Error, files: 0, chunks: 0, error: message });
		return this.currentStatus;
	}

	private log(message: string): void {
		console.log(`[mytrae index] ${message}`);
	}

	override dispose(): void {
		this.stopWorkerWork();
		this.store?.close();
		this.store = undefined;
		super.dispose();
	}
}

function vectors0(store: CodeIndexStore): number {
	for (const row of store.chunksByVector(1)) {
		return fromBlob(row.vector).length;
	}
	return 0;
}

function pushTop(list: { key: string; score: number }[], entry: { key: string; score: number }, limit: number): void {
	list.push(entry);
	if (list.length > limit * 2) {
		list.sort((a, b) => b.score - a.score);
		list.length = limit;
	}
}

/** Splits camelCase, snake_case and path segments into lowercase word tokens. */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const seen = new Set<string>();
	const push = (token: string) => {
		if (token.length >= 2 && token.length <= 40 && !seen.has(token)) {
			seen.add(token);
			tokens.push(token);
		}
	};
	for (const raw of text.match(/[A-Za-z0-9_]+/g) ?? []) {
		const lowered = raw.toLowerCase();
		push(lowered);
		for (const part of raw.split('_')) {
			push(part.toLowerCase());
		}
		for (const part of raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')) {
			push(part.toLowerCase());
		}
	}
	return tokens;
}

function extensionOf(name: string): string {
	const index = name.lastIndexOf('.');
	return index === -1 ? '' : name.slice(index).toLowerCase();
}

function validateDimensions(vectors: readonly Float32Array[]): void {
	if (vectors.length === 0) {
		throw new Error('embedding endpoint returned no vectors');
	}
	const dimension = vectors[0].length;
	if (vectors.some(vector => vector.length !== dimension)) {
		throw new Error('embedding endpoint returned inconsistent dimensions');
	}
	if (dimension === 0) {
		throw new Error('embedding endpoint returned empty vectors');
	}
}
