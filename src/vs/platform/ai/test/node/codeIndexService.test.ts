/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Server } from 'http';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CodeIndexState, ICodeIndexConfiguration, ICodeIndexStatus } from '../../common/codeIndex.js';
import { CodeIndexService } from '../../node/codeIndexService.js';

const DIMENSION = 64;

/** Deterministic bag-of-words hashing so retrieval is meaningfully testable. */
function embedText(text: string): number[] {
	const vector = new Array<number>(DIMENSION).fill(0);
	for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		let hash = 0;
		for (let i = 0; i < raw.length; i++) {
			hash = (hash * 31 + raw.charCodeAt(i)) % DIMENSION;
		}
		vector[hash] += 1;
	}
	return vector;
}

suite('CodeIndexService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let directory: string;
	let server: Server;
	let requests: { model: string; input: string[] }[];
	let failEmbeddings: boolean;

	function configuration(): ICodeIndexConfiguration {
		const address = server.address();
		assert(address && typeof address === 'object');
		return {
			workspaceRoot: directory,
			storageDir: join(directory, '.mytrae-index'),
			embedding: { baseUrl: `http://127.0.0.1:${address.port}`, model: 'fake-embed', apiKey: 'test' },
			maxFiles: 50,
			maxChunks: 200,
			batchSize: 8,
		};
	}

	/** Resolves with the next Ready status event; attach before triggering the sync. */
	function onceReady(service: CodeIndexService): Promise<ICodeIndexStatus> {
		return new Promise(resolve => {
			const subscription = service.onDidChangeStatus(status => {
				if (status.state === CodeIndexState.Ready) {
					subscription.dispose();
					resolve(status);
				}
			});
		});
	}

	setup(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mytrae-index-service-'));
		requests = [];
		failEmbeddings = false;
		const { createServer } = await import('http');
		server = createServer((request, response) => {
			let body = '';
			request.on('data', chunk => { body += chunk; });
			request.on('end', () => {
				if (failEmbeddings) {
					response.writeHead(500, { 'Content-Type': 'text/plain' });
					response.end('embedding backend exploded');
					return;
				}
				const payload = JSON.parse(body) as { model: string; input: string[] };
				requests.push(payload);
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ data: payload.input.map((text, index) => ({ index, embedding: embedText(text) })) }));
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	});

	teardown(async () => {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});

	test('answers empty results before initialization', async () => {
		const service = disposables.add(new CodeIndexService());
		assert.deepStrictEqual(await service.search({ text: 'anything' }), []);
	});

	test('indexes a workspace, skips ignored files and answers hybrid retrieval', async () => {
		await writeFile(join(directory, '.gitignore'), 'ignored/\nREADME.md\n');
		await mkdir(join(directory, 'ignored'), { recursive: true });
		await writeFile(join(directory, 'ignored', 'skip.ts'), 'export function skipped() { return 1; }\n');
		await writeFile(join(directory, 'README.md'), '# readme\n');
		await writeFile(join(directory, 'logo.png'), 'not really a png');
		await mkdir(join(directory, 'src'), { recursive: true });
		await writeFile(join(directory, 'src', 'slugify.ts'), [
			'export function slugify(value: string): string {',
			'  return value.trim().toLowerCase().replace(/\\s+/g, "-");',
			'}',
			'',
			'export const slugifyAll = (values: string[]) => values.map(slugify);',
		].join('\n'));
		await writeFile(join(directory, 'src', 'parseDate.ts'), [
			'export function parseDate(input: string): Date {',
			'  return new Date(input);',
			'}',
		].join('\n'));

		const service = disposables.add(new CodeIndexService());
		const ready = onceReady(service);
		await service.initialize(configuration());
		const status = await ready;
		assert.deepStrictEqual(
			{ state: status.state, files: status.files, chunks: status.chunks, model: status.embeddingModel },
			{ state: CodeIndexState.Ready, files: 2, chunks: 2, model: 'fake-embed' },
		);
		assert.ok(requests.every(request => request.model === 'fake-embed' && request.input.length > 0));

		const hits = await service.search({ text: 'slugify', maxResults: 5 });
		assert.ok(hits.length > 0, 'expected retrieval hits');
		assert.strictEqual(hits[0].path, 'src/slugify.ts');
		assert.ok(hits[0].text.includes('slugify'));
	});

	test('resyncs without re-embedding unchanged files', async () => {
		await writeFile(join(directory, 'a.ts'), 'export const a = 1;\n');
		const service = disposables.add(new CodeIndexService());
		let ready = onceReady(service);
		await service.initialize(configuration());
		await ready;
		const afterFirst = requests.length;
		assert.ok(afterFirst > 0);

		ready = onceReady(service);
		await service.initialize(configuration());
		await ready;
		assert.strictEqual(requests.length, afterFirst);
	});

	test('rebuilds from scratch when the embedding model changes', async () => {
		await writeFile(join(directory, 'a.ts'), 'export const a = 1;\n');
		const service = disposables.add(new CodeIndexService());
		let ready = onceReady(service);
		const firstConfiguration = configuration();
		await service.initialize(firstConfiguration);
		await ready;
		const afterFirst = requests.length;

		ready = onceReady(service);
		await service.initialize({ ...firstConfiguration, embedding: { ...firstConfiguration.embedding, model: 'other-model' } });
		const status = await ready;
		assert.deepStrictEqual(
			{ state: status.state, model: status.embeddingModel, reEmbedded: requests.length > afterFirst },
			{ state: CodeIndexState.Ready, model: 'other-model', reEmbedded: true },
		);
	});

	test('reindex forces a full rebuild', async () => {
		await writeFile(join(directory, 'a.ts'), 'export function alpha() { return 1; }\n');
		const service = disposables.add(new CodeIndexService());
		let ready = onceReady(service);
		await service.initialize(configuration());
		await ready;
		const afterFirst = requests.length;

		ready = onceReady(service);
		await service.reindex();
		await ready;
		assert.ok(requests.length > afterFirst, 'reindex re-embeds everything');

		const hits = await service.search({ text: 'alpha' });
		assert.ok(hits.some(hit => hit.path === 'a.ts'), 'index serves queries after the rebuild');
	});

	test('search fails when the embedding endpoint keeps failing', async () => {
		await writeFile(join(directory, 'a.ts'), 'export const a = 1;\n');
		const service = disposables.add(new CodeIndexService());
		const ready = onceReady(service);
		await service.initialize(configuration());
		await ready;

		failEmbeddings = true;
		try {
			await assert.rejects(service.search({ text: 'alpha' }), /embedding request failed/);
		} finally {
			failEmbeddings = false;
		}
	});
});
