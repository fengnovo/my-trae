/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Contract of the workspace code index (M5). The indexer runs in a utility process; this
 * module only declares the wire shape so the renderer proxy, the indexer and the
 * consumers (chat `@codebase`, agent `search_code`, inline completion) agree on it.
 */

export const codeIndexChannel = 'mytraeCodeIndex';

export const enum CodeIndexState {
	/** Indexing is turned off via settings. */
	Disabled = 'disabled',
	/** No usable embedding endpoint is configured. */
	Unconfigured = 'unconfigured',
	/** No index has been built for this workspace yet. */
	Uninitialized = 'uninitialized',
	Indexing = 'indexing',
	Ready = 'ready',
	Error = 'error',
}

export interface ICodeIndexStatus {
	readonly state: CodeIndexState;
	/** Number of indexed files and chunks currently persisted. */
	readonly files: number;
	readonly chunks: number;
	/** Progress within the current indexing pass. */
	readonly totalFiles?: number;
	readonly indexedFiles?: number;
	readonly embeddingModel?: string;
	readonly dimension?: number;
	readonly error?: string;
}

export interface ICodeIndexConfiguration {
	readonly workspaceRoot: string;
	/** Directory for the single-file sqlite database of this workspace. */
	readonly storageDir: string;
	readonly embedding: {
		readonly baseUrl: string;
		readonly model: string;
		readonly apiKey: string;
	};
	readonly maxFiles?: number;
	readonly maxChunks?: number;
	readonly batchSize?: number;
}

export interface ICodeIndexQuery {
	readonly text: string;
	readonly maxResults?: number;
}

export interface ICodeIndexHit {
	/** Workspace-relative POSIX path. */
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	/** Fused retrieval score, only useful for ordering. */
	readonly score: number;
}

/** Lives in the utility process. Persists chunks and answers hybrid retrieval queries. */
export interface ICodeIndexHost {
	readonly onDidChangeStatus: Event<ICodeIndexStatus>;
	initialize(configuration: ICodeIndexConfiguration): Promise<ICodeIndexStatus>;
	status(): Promise<ICodeIndexStatus>;
	search(query: ICodeIndexQuery): Promise<readonly ICodeIndexHit[]>;
	/** Drop the persisted index and rebuild it from the current workspace contents. */
	reindex(): Promise<ICodeIndexStatus>;
}

export const ICodeIndexService = createDecorator<ICodeIndexService>('mytraeCodeIndexService');

/** Desktop proxy of the indexer utility process. */
export interface ICodeIndexService extends ICodeIndexHost {
	readonly _serviceBrand: undefined;
}
