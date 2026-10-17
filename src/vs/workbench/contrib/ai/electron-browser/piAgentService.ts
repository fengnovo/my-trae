/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IPiAgentHost, IPiAgentService, IPiHostConfiguration, IPiSnapshot, IPiToolRequest, piAgentChannel } from '../../../../platform/ai/common/piAgent.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUtilityProcessWorker, IUtilityProcessWorkerWorkbenchService } from '../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { PiAgentTools } from '../browser/piAgentTools.js';

/** Runs the unmodified Pi loop in a utility process and routes tools through IDE services. */
export class PiAgentService extends Disposable implements IPiAgentService {
	declare readonly _serviceBrand: undefined;
	private readonly changes = this._register(new Emitter<IPiSnapshot>());
	readonly onDidChange = this.changes.event;
	private readonly requests = this._register(new Emitter<IPiToolRequest>());
	readonly onDidRequestTool = this.requests.event;
	private readonly worker = this._register(new MutableDisposable<IUtilityProcessWorker>());
	private readonly events = this._register(new DisposableStore());
	private readonly tools: PiAgentTools;
	private readonly pendingTools = new Map<string, AbortController>();
	private connection: Promise<IPiAgentHost> | undefined;
	private proxy: IPiAgentHost | undefined;
	private generation = 0;
	private cancellationVersion = 0;
	private transitions: Promise<void> = Promise.resolve();
	private cwd: string | undefined;
	private configuration: IPiHostConfiguration | undefined;
	private snapshot: IPiSnapshot | undefined;

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly workers: IUtilityProcessWorkerWorkbenchService,
		@IInstantiationService instantiation: IInstantiationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.tools = this._register(instantiation.createInstance(PiAgentTools, (url, signal) => this.fetchWebWithSignal(url, signal)));
	}

	private getHost(): Promise<IPiAgentHost> {
		if (this._store.isDisposed) { return Promise.reject(new CancellationError()); }
		if (!this.connection) {
			const connection = this.connect(this.generation).catch(error => {
				// An older failed connection must not clear a newer worker's promise.
				if (this.connection === connection) { this.connection = undefined; }
				throw error;
			});
			this.connection = connection;
		}
		return this.connection;
	}

	private async connect(generation: number): Promise<IPiAgentHost> {
		const creating = this.workers.createWorker({ moduleId: 'vs/platform/ai/node/piAgentMain', type: 'mytraePiAgent', name: 'MyTrae Pi Agent' });
		const worker = await raceTimeout(creating, 15000, () => {
			this.generation++;
			void creating.then(late => late.dispose(), error => this.log.warn('[pi] worker startup failed', error));
		});
		if (!worker) { throw new Error(localize('pi.startTimeout', "Pi agent process did not start within 15 seconds.")); }
		if (generation !== this.generation || this._store.isDisposed) { worker.dispose(); throw new CancellationError(); }
		this.worker.value = worker;
		const host = ProxyChannel.toService<IPiAgentHost>(worker.client.getChannel(piAgentChannel), { disableMarshalling: true });
		this.proxy = host;
		this.events.add(host.onDidChange(snapshot => {
			if (this.proxy !== host || generation !== this.generation) { return; }
			this.snapshot = snapshot;
			this.changes.fire(snapshot);
		}));
		this.events.add(host.onDidRequestTool(request => {
			if (this.proxy !== host || generation !== this.generation) { return; }
			const abort = new AbortController();
			this.pendingTools.set(request.id, abort);
			this.requests.fire(request);
			void this.tools.execute(request, abort.signal).catch(error => ({ text: error instanceof Error ? error.message : String(error), isError: true })).then(async result => {
				if (!abort.signal.aborted && this.proxy === host) { await host.completeTool({ id: request.id, result }); }
			}).catch(error => this.log.warn('[pi] tool reply failed', error)).finally(() => this.pendingTools.delete(request.id));
		}));
		void worker.onDidTerminate.then(({ reason }) => {
			if (this.worker.value !== worker) { return; }
			this.cancelTools();
			this.generation++;
			this.events.clear();
			this.worker.clear();
			this.connection = undefined;
			this.proxy = undefined;
			if (this.snapshot) {
				this.snapshot = { ...this.snapshot, isStreaming: false, turns: [...this.snapshot.turns.map(turn => ({ ...turn, pending: false })), { id: `exit-${Date.now()}`, role: 'assistant', content: localize('pi.processStopped', "Pi agent process stopped: {0}", String(reason)), error: String(reason) }] };
				this.changes.fire(this.snapshot);
			}
		});
		if (this.configuration) { await host.initialize(this.configuration); }
		if (generation !== this.generation || this.proxy !== host || this._store.isDisposed) { throw new CancellationError(); }
		return host;
	}

	private cancelTools(): void {
		for (const abort of this.pendingTools.values()) { abort.abort(); }
		this.pendingTools.clear();
	}

	async initialize(configuration: IPiHostConfiguration): Promise<IPiSnapshot> {
		const aborted = this.abort();
		return this.transition(async () => {
			await aborted;
			if (this.cwd !== configuration.cwd) { this.tools.reset(); this.cwd = configuration.cwd; }
			const host = await this.getHost();
			const snapshot = await host.initialize(configuration);
			this.snapshot = snapshot;
			this.configuration = configuration;
			return snapshot;
		});
	}

	async prompt(input: Parameters<IPiAgentHost['prompt']>[0]): Promise<void> {
		const cancellationVersion = this.cancellationVersion;
		await this.transitions;
		if (cancellationVersion !== this.cancellationVersion) { return; }
		const host = await this.getHost();
		if (cancellationVersion !== this.cancellationVersion || this._store.isDisposed) { return; }
		return host.prompt(input);
	}
	async abort(): Promise<void> { ++this.cancellationVersion; this.cancelTools(); await this.proxy?.abort(); }
	async listSessions() { await this.transitions; return (await this.getHost()).listSessions(); }
	async openSession(path: string): Promise<IPiSnapshot> {
		const aborted = this.abort();
		return this.transition(async () => {
			await aborted;
			const snapshot = await (await this.getHost()).openSession(path);
			this.snapshot = snapshot;
			this.tools.reset();
			return snapshot;
		});
	}
	async newSession(): Promise<IPiSnapshot> {
		const aborted = this.abort();
		return this.transition(async () => {
			await aborted;
			const snapshot = await (await this.getHost()).newSession();
			this.snapshot = snapshot;
			this.tools.reset();
			return snapshot;
		});
	}
	async deleteSession(path: string): Promise<void> {
		const aborted = this.abort();
		return this.transition(async () => {
			await aborted;
			const previousId = this.snapshot?.session.id;
			const deletingActive = this.snapshot?.session.path === path;
			await (await this.getHost()).deleteSession(path);
			if (deletingActive || previousId !== this.snapshot?.session.id) { this.tools.reset(); }
		});
	}
	private transition<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.transitions.then(operation);
		this.transitions = result.then(() => undefined, () => undefined);
		return result;
	}
	async completeTool(input: Parameters<IPiAgentHost['completeTool']>[0]): Promise<void> { await (await this.getHost()).completeTool(input); }
	async fetchWeb(input: { url: string }): Promise<string> { return this.fetchWebWithSignal(input.url); }
	private async fetchWebWithSignal(url: string, signal?: AbortSignal): Promise<string> {
		const cancellationVersion = this.cancellationVersion;
		if (signal?.aborted) { throw new CancellationError(); }
		const host = await this.getHost();
		if (signal?.aborted || cancellationVersion !== this.cancellationVersion) { throw new CancellationError(); }
		const result = await host.fetchWeb({ url });
		if (signal?.aborted || cancellationVersion !== this.cancellationVersion) { throw new CancellationError(); }
		return result;
	}
	async rollback(): Promise<void> { await this.tools.rollback(); }

	override dispose(): void {
		this.generation++;
		this.cancellationVersion++;
		this.cancelTools();
		super.dispose();
	}
}
