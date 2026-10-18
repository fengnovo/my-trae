/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CancellationError, getErrorMessage } from '../../../../base/common/errors.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { AIRequestPurpose, ILLMService, LLMProviderKind } from '../../../../platform/ai/common/ai.js';
import { AIConfig, readAIConfiguration } from '../../../../platform/ai/common/aiConfiguration.js';
import { ICodeIndexService } from '../../../../platform/ai/common/codeIndex.js';
import { IPiAgentService, IPiPlanStep, IPiSessionInfo, IPiSnapshot, PiAgentMode } from '../../../../platform/ai/common/piAgent.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AIChatContextKind, AIChatRole, IAIChatContextItem, IAIChatService, IAIChatSession } from '../common/aiChat.js';
import { buildContextBlock } from '../common/prompts.js';

/** Projects Pi's persisted transcript without maintaining a second agent or history store. */
export class PiAIChatService extends Disposable implements IAIChatService {
	declare readonly _serviceBrand: undefined;
	private readonly changes = this._register(new Emitter<IAIChatSession>());
	readonly onDidChange = this.changes.event;
	private sessionInfos: readonly IPiSessionInfo[] = [];
	private sessionsList: IAIChatSession[] = [];
	private active: IAIChatSession | undefined;
	private busy = false;
	private hostStreaming = false;
	private initialized = false;
	private generation = 0;
	private operation: AbortController | undefined;
	private pendingMode: PiAgentMode | undefined;
	private initialization: Promise<void>;
	mode: PiAgentMode = 'build';
	plan: readonly IPiPlanStep[] = [];
	initializationError: string | undefined;

	constructor(
		@IPiAgentService private readonly host: IPiAgentService,
		@ILLMService private readonly llm: ILLMService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEnvironmentService private readonly environment: IEnvironmentService,
		@IFileService private readonly files: IFileService,
		@IModelService private readonly models: IModelService,
		@ICodeIndexService private readonly index: ICodeIndexService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(host.onDidChange(snapshot => this.project(snapshot)));
		this.initialization = this.initialize();
		this._register(llm.onDidChangeConfiguration(() => this.reinitialize()));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.reinitialize()));
	}

	get ready(): Promise<void> { return this.initialization; }
	get sessions(): readonly IAIChatSession[] { return this.sessionsList; }
	get activeSession(): IAIChatSession | undefined { return this.active; }
	get isStreaming(): boolean { return this.busy || this.hostStreaming; }

	private reinitialize(): void {
		this.cancel();
		this.generation++;
		this.initialized = false;
		this.initialization = this.initialization.then(() => this.initialize());
	}

	private async initialize(): Promise<void> {
		const generation = ++this.generation;
		try {
			const endpoint = await this.llm.resolveEndpoint(AIRequestPurpose.Agent);
			const settings = readAIConfiguration(this.configuration);
			const root = this.workspace.getWorkspace().folders[0]?.uri;
			if (root && root.scheme !== 'file') {
				throw new Error(localize('pi.localWorkspace', "Pi requires a local workspace."));
			}
			const home = URI.joinPath(this.environment.userRoamingDataHome, 'mytrae', 'pi');
			const cwd = root?.fsPath ?? URI.joinPath(home, 'empty-workspace').fsPath;
			const contextWindow = this.configuration.getValue<number>(AIConfig.AgentContextWindow) || this.llm.listModels().find(model => model.id === endpoint.model)?.contextWindow || 32768;
			const snapshot = await this.host.initialize({ cwd, agentDir: URI.joinPath(home, 'config').fsPath, sessionDir: URI.joinPath(home, 'sessions', String(hash(cwd))).fsPath, endpoint: { ...endpoint, providerId: settings.providerId, api: endpoint.kind === LLMProviderKind.Anthropic ? 'anthropic-messages' : 'openai-completions', contextWindow, maxTokens: Math.min(settings.maxTokens, Math.floor(contextWindow / 2)) }, maxSteps: settings.agentMaxSteps });
			if (generation !== this.generation || this._store.isDisposed) { return; }
			this.initialized = true;
			this.initializationError = undefined;
			await this.refreshSessions();
			this.project(snapshot);
		} catch (error) {
			this.initializationError = error instanceof Error ? error.message : String(error);
			this.log.warn('[pi] initialization failed', error);
			this.notify();
		}
	}

	private async refreshSessions(): Promise<void> {
		this.sessionInfos = await this.host.listSessions();
		this.sessionsList = this.sessionInfos.map(info => this.active?.id === info.id ? this.active : { id: info.id, title: info.title, createdAt: info.updatedAt, turns: [] });
	}

	private project(snapshot: IPiSnapshot): void {
		this.active = { id: snapshot.session.id, title: snapshot.session.title, createdAt: snapshot.session.updatedAt, turns: snapshot.turns.map(turn => ({ ...turn, role: turn.role === 'tool' ? AIChatRole.Tool : turn.role === 'user' ? AIChatRole.User : AIChatRole.Assistant, createdAt: snapshot.session.updatedAt })) };
		this.sessionInfos = [snapshot.session, ...this.sessionInfos.filter(info => info.id !== snapshot.session.id)];
		this.sessionsList = [this.active, ...this.sessionsList.filter(session => session.id !== this.active?.id)];
		this.hostStreaming = snapshot.isStreaming;
		this.mode = this.pendingMode ?? snapshot.mode;
		this.plan = snapshot.plan;
		this.notify();
	}

	private notify(): void {
		this.changes.fire(this.active ?? { id: '', title: '', createdAt: 0, turns: [] });
	}

	setMode(mode: PiAgentMode): void {
		if (!this.isStreaming) { this.mode = mode; this.pendingMode = mode; this.notify(); }
	}

	private async ensureReady(): Promise<void> {
		let pending: Promise<void>;
		do { pending = this.initialization; await pending; } while (pending !== this.initialization);
		if (!this.initialized) {
			this.initialization = this.initialize();
			await this.ready;
		}
		if (!this.initialized) { throw new Error(this.initializationError); }
	}

	private async sessionAction<T>(action: () => Promise<T>): Promise<T> {
		if (this.isStreaming) { throw new Error(localize('pi.sessionBusy', "Stop the current operation before changing sessions.")); }
		this.busy = true;
		this.notify();
		try {
			await this.ensureReady();
			this.pendingMode = undefined;
			return await action();
		} finally {
			this.busy = false;
			this.notify();
		}
	}

	async createSession(): Promise<IAIChatSession> {
		return this.sessionAction(async () => {
			this.project(await this.host.newSession());
			return this.active!;
		});
	}

	async setActiveSession(id: string): Promise<void> {
		await this.sessionAction(async () => {
			const info = this.sessionInfos.find(session => session.id === id);
			if (info) { this.project(await this.host.openSession(info.path)); }
		});
	}

	async deleteSession(id: string): Promise<void> {
		await this.sessionAction(async () => {
			const info = this.sessionInfos.find(session => session.id === id);
			if (!info) { return; }
			await this.host.deleteSession(info.path);
			await this.refreshSessions();
		});
	}

	async send(text: string, context: readonly IAIChatContextItem[]): Promise<void> {
		if (!text.trim() || this.isStreaming) { return; }
		const mode = this.mode;
		const operation = new AbortController();
		this.operation = operation;
		this.busy = true;
		this.notify();
		try {
			await this.ensureReady();
			const resolved: IAIChatContextItem[] = [];
			const question = text.trim();
			for (const item of context) {
				if (item.kind === AIChatContextKind.Codebase) {
					resolved.push(await this.resolveCodebase(item, question, operation.signal));
					continue;
				}
				if (item.text !== undefined || !item.uri) { resolved.push(item); continue; }
				const model = this.models.getModel(item.uri);
				const fileText = model ? (item.range ? model.getValueInRange(item.range) : model.getValue()) : (await this.files.readFile(item.uri)).value.toString();
				if (!model && item.range) {
					const lines = fileText.split(/\r?\n/).slice(item.range.startLineNumber - 1, item.range.endLineNumber);
					if (lines.length) {
						lines[lines.length - 1] = lines[lines.length - 1].slice(0, item.range.endColumn - 1);
						lines[0] = lines[0].slice(item.range.startColumn - 1);
					}
					resolved.push({ ...item, text: lines.join('\n') });
				} else { resolved.push({ ...item, text: fileText }); }
			}
			if (!operation.signal.aborted) {
				this.pendingMode = undefined;
				await this.host.prompt({ text: question, context: buildContextBlock(resolved), mode });
			}
		} finally {
			this.busy = false;
			this.operation = undefined;
			this.notify();
		}
	}

	/** Retrieval over the workspace index for `@codebase`; failures degrade to a note. */
	private async resolveCodebase(item: IAIChatContextItem, query: string, signal: AbortSignal): Promise<IAIChatContextItem> {
		if (!query) {
			return { ...item, text: '' };
		}
		try {
			const hits = await this.index.search({ text: query, maxResults: 8 });
			if (hits.length === 0) {
				return { ...item, text: localize('pi.indexNoHits', "The workspace index returned no matches for this question.") };
			}
			const body = hits.map(hit => `<retrieved path="${hit.path}" lines="${hit.startLine}-${hit.endLine}">\n${hit.text.slice(0, 2400)}\n</retrieved>`).join('\n');
			return { ...item, text: `${localize('pi.indexHeader', "Semantic matches from the workspace index (verify against the files before relying on them):")}\n${body}` };
		} catch (error) {
			if (signal.aborted) {
				throw new CancellationError();
			}
			this.log.warn('[pi] codebase retrieval failed', error);
			return { ...item, text: localize('pi.indexUnavailable', "Codebase index unavailable: {0}", getErrorMessage(error)) };
		}
	}

	cancel(): void {
		this.operation?.abort();
		void this.host.abort().catch(error => this.log.warn('[pi] abort failed', error));
	}

	async rollback(): Promise<void> { if (!this.isStreaming) { await this.host.rollback(); } }

	override dispose(): void {
		this.generation++;
		this.cancel();
		super.dispose();
	}
}
