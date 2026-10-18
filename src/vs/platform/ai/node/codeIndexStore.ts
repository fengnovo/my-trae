/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from '../../../base/common/path.js';

/**
 * Single-file sqlite persistence for the code index (M5). Chunk vectors are stored
 * L2-normalized as float32 blobs so cosine similarity reduces to a dot product during
 * retrieval. sqlite-vec's loadable extension is intentionally not vendored for now:
 * brute-force scan in the utility process stays well inside budget at the documented
 * chunk cap, and skipping the native dylib keeps packaging dependency-free.
 */

export interface IStoredChunk {
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly vector: Float32Array;
}

export interface IFileRecord {
	readonly path: string;
	/** Cheap change key (size + mtime) used to skip unchanged files on rescan. */
	readonly key: string;
	readonly chunks: number;
}

export interface IChunkRow {
	id: number;
	path: string;
	start_line: number;
	end_line: number;
	text: string;
	vector: Uint8Array;
}

const SCHEMA_VERSION = '1';

export class CodeIndexStore {
	private readonly database: DatabaseSync;

	private constructor(database: DatabaseSync) {
		this.database = database;
	}

	static open(storageDir: string): CodeIndexStore {
		// eslint-disable-next-line local/code-no-sync-fs -- the store is a synchronous API by design around node:sqlite's DatabaseSync
		mkdirSync(storageDir, { recursive: true });
		const database = new DatabaseSync(join(storageDir, 'index.db'));
		database.exec('PRAGMA journal_mode = WAL;');
		database.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, key TEXT NOT NULL, chunks INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				text TEXT NOT NULL,
				vector BLOB NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
		`);
		const store = new CodeIndexStore(database);
		if (store.meta('schemaVersion') !== SCHEMA_VERSION) {
			store.clear();
			store.setMeta('schemaVersion', SCHEMA_VERSION);
		}
		return store;
	}

	meta(key: string): string | undefined {
		const row = this.database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
		return row?.value;
	}

	setMeta(key: string, value: string): void {
		this.database.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
	}

	file(path: string): IFileRecord | undefined {
		const row = this.database.prepare('SELECT path, key, chunks FROM files WHERE path = ?').get(path) as unknown as IFileRecord | undefined;
		return row;
	}

	paths(): IFileRecord[] {
		return this.database.prepare('SELECT path, key, chunks FROM files').all() as unknown as IFileRecord[];
	}

	upsertFile(path: string, key: string, chunks: readonly IStoredChunk[]): void {
		this.database.exec('BEGIN');
		try {
			this.database.prepare('DELETE FROM chunks WHERE path = ?').run(path);
			this.database.prepare('INSERT INTO files (path, key, chunks) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET key = excluded.key, chunks = excluded.chunks').run(path, key, chunks.length);
			const insert = this.database.prepare('INSERT INTO chunks (path, start_line, end_line, text, vector) VALUES (?, ?, ?, ?, ?)');
			for (const chunk of chunks) {
				insert.run(path, chunk.startLine, chunk.endLine, chunk.text, toBlob(chunk.vector));
			}
			this.database.exec('COMMIT');
		} catch (error) {
			try { this.database.exec('ROLLBACK'); } catch { /* connection-level failure, nothing to roll back */ }
			throw error;
		}
	}

	deleteFile(path: string): void {
		this.database.prepare('DELETE FROM chunks WHERE path = ?').run(path);
		this.database.prepare('DELETE FROM files WHERE path = ?').run(path);
	}

	counts(): { files: number; chunks: number } {
		const files = (this.database.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
		const chunks = (this.database.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
		return { files, chunks };
	}

	/** Streams chunks in pages so retrieval never materializes the whole vector set. */
	*chunksByVector(pageSize = 1000): Generator<IChunkRow> {
		let lastId = 0;
		const select = this.database.prepare('SELECT id, path, start_line, end_line, text, vector FROM chunks WHERE id > ? ORDER BY id LIMIT ?');
		while (true) {
			const rows = select.all(lastId, pageSize) as unknown as IChunkRow[];
			if (rows.length === 0) {
				return;
			}
			for (const row of rows) {
				lastId = row.id;
				yield row;
			}
		}
	}

	clear(): void {
		this.database.exec('DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;');
	}

	close(): void {
		this.database.close();
	}
}

export function toBlob(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
	// sqlite may hand back a Buffer at an unaligned byte offset; copy to stay safe.
	const bytes = Buffer.from(blob);
	return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function normalize(vector: Float32Array): Float32Array {
	let sum = 0;
	for (const value of vector) {
		sum += value * value;
	}
	const magnitude = Math.sqrt(sum);
	if (magnitude === 0) {
		return vector;
	}
	const normalized = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) {
		normalized[i] = vector[i] / magnitude;
	}
	return normalized;
}
