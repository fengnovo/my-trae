/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IAICredentialsService } from '../../../../platform/ai/common/ai.js';
import { AIConfig, readAIConfiguration } from '../../../../platform/ai/common/aiConfiguration.js';
import { CodeIndexState, codeIndexChannel, ICodeIndexConfiguration, ICodeIndexHit, ICodeIndexHost, ICodeIndexQuery, ICodeIndexService, ICodeIndexStatus } from '../../../../platform/ai/common/codeIndex.js';
import { findProviderPreset } from '../../../../platform/ai/common/modelCatalog.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUtilityProcessWorker, IUtilityProcessWorkerWorkbenchService } from '../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';

/**
 * Renderer proxy of the workspace indexer. Owns the utility process lifecycle, resolves
 * the embedding configuration (including the encrypted key) and re-spawns whenever the
 * workspace or the embedding settings change.
 */
export class WorkspaceCodeIndexService extends Disposable implements ICodeIndexService {
	declare readonly _serviceBrand: undefined;

	private readonly changes = this._register(new Emitter<ICodeIndexStatus>());
	readonly onDidChangeStatus: Event<ICodeIndexStatus> = this.changes.event;

	private readonly worker = this._register(new MutableDisposable<IUtilityProcessWorker>());
	private readonly events = this._register(new DisposableStore());
	private connection: Promise<void> | undefined;
	private proxy: ICodeIndexHost | undefined;
	private generation = 0;
	private currentStatus: ICodeIndexStatus = { state: CodeIndexState.Uninitialized, files: 0, chunks: 0 };

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly workers: IUtilityProcessWorkerWorkbenchService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAICredentialsService private readonly credentialsService: IAICredentialsService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.restart()));
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, event => indexRelevantKeys.some(key => event.affectsConfiguration(key)))(() => this.restart()));
		// The service is registered eagerly; kick the first sync without waiting for a
		// settings change, otherwise a pre-configured workspace never gets indexed.
		void this.initialize().catch(error => this.logService.warn('[index] startup failed', error));
	}

	private setStatus(status: ICodeIndexStatus): void {
		this.currentStatus = status;
		this.changes.fire(status);
	}

	/** Drops the current worker and re-resolves configuration (workspace or settings change). */
	private restart(): void {
		this.generation++;
		this.events.clear();
		this.worker.clear();
		this.connection = undefined;
		this.proxy = undefined;
		this.setStatus({ state: CodeIndexState.Uninitialized, files: 0, chunks: 0 });
		void this.initialize().catch(error => this.logService.warn('[index] restart failed', error));
	}

	async initialize(): Promise<ICodeIndexStatus> {
		if (!this.connection) {
			this.connection = this.start().catch(error => {
				if (this.connection) {
					this.connection = undefined;
					this.logService.warn('[index] worker startup failed', error);
					this.setStatus({ state: CodeIndexState.Error, files: 0, chunks: 0, error: error instanceof Error ? error.message : String(error) });
				}
			});
		}
		await this.connection;
		return this.currentStatus;
	}

	private async start(): Promise<void> {
		const generation = this.generation;
		const configuration = await this.resolveConfiguration();
		if (!configuration || generation !== this.generation || this._store.isDisposed) {
			return;
		}
		const creating = this.workers.createWorker({ moduleId: 'vs/platform/ai/node/codeIndexMain', type: 'mytraeCodeIndex', name: 'MyTrae Code Index' });
		const worker = await raceTimeout(creating, 15000, () => {
			void creating.then(late => late.dispose(), error => this.logService.warn('[index] worker startup failed', error));
		});
		if (!worker) {
			throw new Error(localize('index.startTimeout', "Code index process did not start within 15 seconds."));
		}
		if (generation !== this.generation || this._store.isDisposed) {
			worker.dispose();
			throw new CancellationError();
		}
		this.worker.value = worker;
		const proxy = ProxyChannel.toService<ICodeIndexHost>(worker.client.getChannel(codeIndexChannel));
		this.proxy = proxy;
		this.events.add(proxy.onDidChangeStatus(status => {
			if (this.proxy === proxy) {
				this.setStatus(status);
			}
		}));
		await proxy.initialize(configuration);
		if (generation !== this.generation || this.proxy !== proxy) {
			throw new CancellationError();
		}
	}

	private async resolveConfiguration(): Promise<ICodeIndexConfiguration | undefined> {
		const settings = readAIConfiguration(this.configurationService);
		const root = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!root || root.scheme !== 'file') {
			return undefined;
		}
		const enabled = this.configurationService.getValue<boolean>(AIConfig.IndexingEnabled, { resource: root }) ?? true;
		if (!enabled) {
			this.setStatus({ state: CodeIndexState.Disabled, files: 0, chunks: 0 });
			return undefined;
		}
		const providerId = settings.embedding.providerId;
		const baseUrl = settings.embedding.baseUrl || findProviderPreset(providerId)?.baseUrl;
		if (!baseUrl) {
			this.setStatus({ state: CodeIndexState.Unconfigured, files: 0, chunks: 0 });
			return undefined;
		}
		let apiKey = await this.credentialsService.getApiKey(providerId);
		if (!apiKey) {
			if (findProviderPreset(providerId)?.local === true) {
				// Local endpoints accept any value; keep the header well formed.
				apiKey = 'not-needed';
			} else {
				this.setStatus({ state: CodeIndexState.Unconfigured, files: 0, chunks: 0 });
				return undefined;
			}
		}
		return {
			workspaceRoot: root.fsPath,
			storageDir: URI.joinPath(this.environmentService.userRoamingDataHome, 'mytrae', 'index', String(hash(root.toString()))).fsPath,
			embedding: { baseUrl, model: settings.embedding.model, apiKey },
		};
	}

	async status(): Promise<ICodeIndexStatus> {
		return this.currentStatus;
	}

	async search(query: ICodeIndexQuery): Promise<readonly ICodeIndexHit[]> {
		await this.initialize();
		if (!this.proxy) {
			return [];
		}
		return this.proxy.search(query);
	}

	async reindex(): Promise<ICodeIndexStatus> {
		await this.initialize();
		if (!this.proxy) {
			return this.currentStatus;
		}
		return this.proxy.reindex();
	}

	override dispose(): void {
		this.generation++;
		super.dispose();
	}
}

/** Only these settings changes respawn the indexer; unrelated myTrae keys must not. */
const indexRelevantKeys = [
	AIConfig.Provider,
	AIConfig.BaseUrl,
	AIConfig.EmbeddingProvider,
	AIConfig.EmbeddingBaseUrl,
	AIConfig.EmbeddingModel,
	AIConfig.IndexingEnabled,
];
