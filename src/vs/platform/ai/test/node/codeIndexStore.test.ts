/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CodeIndexStore, fromBlob, normalize, toBlob } from '../../node/codeIndexStore.js';

suite('CodeIndexStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let directory: string;

	setup(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mytrae-index-store-'));
	});

	teardown(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test('persists files, chunks and meta across reopen', async () => {
		const store = CodeIndexStore.open(join(directory, 'db'));
		const vector = new Float32Array([1, 2, 3]);
		store.upsertFile('a.ts', '10:100', [{ startLine: 1, endLine: 5, text: 'const a = 1;', vector }]);
		store.upsertFile('b.ts', '20:200', [
			{ startLine: 1, endLine: 3, text: 'const b = 2;', vector: new Float32Array([4, 5, 6]) },
			{ startLine: 4, endLine: 9, text: 'const c = 3;', vector: new Float32Array([7, 8, 9]) },
		]);
		store.setMeta('embeddingModel', 'fake-embed');
		store.close();

		const reopened = CodeIndexStore.open(join(directory, 'db'));
		const rows = [...reopened.chunksByVector()];
		assert.deepStrictEqual(
			{
				counts: reopened.counts(),
				paths: reopened.paths().map(record => record.path),
				file: { ...reopened.file('a.ts')! },
				model: reopened.meta('embeddingModel'),
				rowCount: rows.length,
				firstVector: [...fromBlob(rows[0].vector)],
				firstRow: { path: rows[0].path, startLine: rows[0].start_line, endLine: rows[0].end_line },
				lastRow: { path: rows[2].path, startLine: rows[2].start_line },
			},
			{
				counts: { files: 2, chunks: 3 },
				paths: ['a.ts', 'b.ts'],
				file: { path: 'a.ts', key: '10:100', chunks: 1 },
				model: 'fake-embed',
				rowCount: 3,
				firstVector: [1, 2, 3],
				firstRow: { path: 'a.ts', startLine: 1, endLine: 5 },
				lastRow: { path: 'b.ts', startLine: 4 },
			},
		);
		reopened.close();
	});

	test('streams chunks in pages and deletes per file', () => {
		const store = CodeIndexStore.open(join(directory, 'db'));
		const vector = new Float32Array([1]);
		store.upsertFile('a.ts', '1:1', [
			{ startLine: 1, endLine: 2, text: 'a', vector },
			{ startLine: 3, endLine: 4, text: 'b', vector },
			{ startLine: 5, endLine: 6, text: 'c', vector },
		]);
		store.upsertFile('b.ts', '1:1', [{ startLine: 1, endLine: 2, text: 'd', vector }]);

		const paged = [...store.chunksByVector(2)];
		store.deleteFile('a.ts');
		assert.deepStrictEqual(
			{ pagedPaths: paged.map(row => row.path), afterDelete: store.counts() },
			{ pagedPaths: ['a.ts', 'a.ts', 'a.ts', 'b.ts'], afterDelete: { files: 1, chunks: 1 } },
		);
		store.close();
	});

	test('round-trips blobs and normalizes vectors', () => {
		const vector = new Float32Array([1.5, -2.25, 0.5]);
		const rounded = (values: Float32Array) => [...values].map(value => Math.round(value * 1e6) / 1e6);
		assert.deepStrictEqual([...fromBlob(toBlob(vector))], [...vector]);
		assert.deepStrictEqual(rounded(normalize(new Float32Array([3, 4]))), [0.6, 0.8]);
		assert.deepStrictEqual([...normalize(new Float32Array([0, 0]))], [0, 0]);
	});
});
