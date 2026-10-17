/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import {
	AIRequestPurpose,
	ILLMMessage,
	ILLMRequest,
	ILLMService,
} from '../../../../platform/ai/common/ai.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	InstantiationType,
	registerSingleton,
} from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	AIChatContextKind,
	AIChatRole,
	IAIChatContextItem,
	IAIChatRange,
	IAIChatSession,
	IAIChatService,
	IAIChatTurn,
} from '../common/aiChat.js';
import { buildContextBlock, CHAT_SYSTEM_PROMPT } from '../common/prompts.js';

/** Sessions kept on disk. Older conversations are dropped to bound the file size. */
const MAX_PERSISTED_SESSIONS = 50;
/** Interval used to coalesce token-by-token updates into one UI refresh. */
const STREAM_UPDATE_INTERVAL_MS = 60;

class ChatSession implements IAIChatSession {
	readonly turns: IAIChatTurn[] = [];
	title = '';

	constructor(
		readonly id: string,
		readonly createdAt: number,
		title?: string,
	) {
		this.title = title ?? '';
	}
}

/**
 * Owns the conversation state of the AI panel: session lifecycle, streaming of assistant
 * replies and JSONL persistence under the user's roaming data folder.
 *
 * The wire format is deliberately not leaked here; turns are translated into
 * {@link ILLMMessage} only at request time.
 */
export class AIChatService extends Disposable implements IAIChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IAIChatSession>());
	readonly onDidChange: Event<IAIChatSession> = this._onDidChange.event;

	private readonly sessionsList: ChatSession[] = [];
	private activeSessionId: string | undefined;
	private currentAbort: AbortController | undefined;
	private readonly storageResource: URI;

	private readonly saveScheduler: RunOnceScheduler;
	private readonly streamScheduler: RunOnceScheduler;

	constructor(
		@ILLMService private readonly llmService: ILLMService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.storageResource = URI.joinPath(
			environmentService.userRoamingDataHome,
			'mytrae',
			'chat-sessions.jsonl',
		);
		this.saveScheduler = this._register(
			new RunOnceScheduler(() => void this.persist(), 500),
		);
		this.streamScheduler = this._register(
			new RunOnceScheduler(() => {
				const session = this.activeSession;
				if (session) {
					this._onDidChange.fire(session);
				}
			}, STREAM_UPDATE_INTERVAL_MS),
		);

		void this.restore();
	}

	get sessions(): readonly IAIChatSession[] {
		return this.sessionsList;
	}

	get activeSession(): IAIChatSession | undefined {
		return this.sessionsList.find(
			(session) => session.id === this.activeSessionId,
		);
	}

	get isStreaming(): boolean {
		return this.currentAbort !== undefined;
	}

	createSession(): IAIChatSession {
		const session = new ChatSession(generateUuid(), Date.now());
		this.sessionsList.unshift(session);
		this.activeSessionId = session.id;
		this.saveScheduler.schedule();
		this._onDidChange.fire(session);
		return session;
	}

	setActiveSession(sessionId: string): void {
		if (this.activeSessionId === sessionId) {
			return;
		}
		this.cancel();
		this.activeSessionId = sessionId;
		const session = this.activeSession;
		if (session) {
			this._onDidChange.fire(session);
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		const index = this.sessionsList.findIndex(
			(session) => session.id === sessionId,
		);
		if (index === -1) {
			return;
		}
		if (this.activeSessionId === sessionId) {
			this.cancel();
		}
		this.sessionsList.splice(index, 1);
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = this.sessionsList[0]?.id;
		}
		await this.persist();
		this._onDidChange.fire(
			this.activeSession ??
				this.sessionsList[0] ??
				new ChatSession(generateUuid(), Date.now()),
		);
	}

	async send(
		text: string,
		context: readonly IAIChatContextItem[],
	): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0 || this.isStreaming) {
			return;
		}

		const session =
			(this.activeSession as ChatSession | undefined) ??
			(this.createSession() as ChatSession);
		const resolvedContext = await this.resolveContext(context);

		session.turns.push({
			id: generateUuid(),
			role: AIChatRole.User,
			content: trimmed,
			createdAt: Date.now(),
			context: resolvedContext,
		});
		if (session.title.length === 0) {
			session.title = trimmed.split('\n')[0].slice(0, 60);
		}

		const assistantTurn: IAIChatTurn = {
			id: generateUuid(),
			role: AIChatRole.Assistant,
			content: '',
			createdAt: Date.now(),
			pending: true,
		};
		session.turns.push(assistantTurn);
		this._onDidChange.fire(session);

		const abort = new AbortController();
		this.currentAbort = abort;

		try {
			const request: ILLMRequest = {
				purpose: AIRequestPurpose.Chat,
				messages: this.toMessages(session),
			};
			for await (const chunk of this.llmService.streamChat(
				request,
				abort.signal,
			)) {
				if (chunk.textDelta) {
					assistantTurn.content += chunk.textDelta;
					this.streamScheduler.schedule();
				}
			}
			assistantTurn.pending = false;
		} catch (error) {
			assistantTurn.pending = false;
			if (abort.signal.aborted) {
				const cancelled = localize('myTrae.chat.cancelled', "_(cancelled)_");
				assistantTurn.content +=
					assistantTurn.content.length > 0 ? `\n\n${cancelled}` : cancelled;
			} else {
				const message = error instanceof Error ? error.message : String(error);
				assistantTurn.error = message;
				if (assistantTurn.content.length === 0) {
					assistantTurn.content = message;
				}
				this.logService.error('[ai] chat request failed', error);
			}
		} finally {
			this.currentAbort = undefined;
			this.streamScheduler.cancel();
			this.saveScheduler.schedule();
			this._onDidChange.fire(session);
		}
	}

	cancel(): void {
		this.currentAbort?.abort();
		this.currentAbort = undefined;
	}

	// --- Message building ---

	private toMessages(session: ChatSession): ILLMMessage[] {
		const messages: ILLMMessage[] = [
			{ role: 'system', content: CHAT_SYSTEM_PROMPT },
		];
		const lastIndex = session.turns.length - 1;

		for (let i = 0; i < session.turns.length; i++) {
			const turn = session.turns[i];
			if (turn.role === AIChatRole.System) {
				continue;
			}
			if (
				turn.role === AIChatRole.Assistant &&
				(turn.pending || turn.content.length === 0)
			) {
				// The in-flight or failed assistant placeholder is never part of the prompt.
				continue;
			}

			let content = turn.content;
			if (i === lastIndex && turn.context && turn.context.length > 0) {
				const block = buildContextBlock(turn.context);
				content = block.length > 0 ? `${block}\n\n${content}` : content;
			}
			messages.push({
				role: turn.role === AIChatRole.User ? 'user' : 'assistant',
				content,
			});
		}

		return messages;
	}

	/** Fills in the text of references that only carry a resource, so the prompt is self contained. */
	private async resolveContext(
		context: readonly IAIChatContextItem[],
	): Promise<readonly IAIChatContextItem[]> {
		const resolved: IAIChatContextItem[] = [];
		for (const item of context) {
			if (item.text !== undefined || !item.uri) {
				resolved.push(item);
				continue;
			}
			try {
				const content = await this.fileService.readFile(item.uri);
				const text = content.value.toString();
				resolved.push({
					...item,
					text: item.range ? extractRange(text, item.range) : text,
				});
			} catch (error) {
				this.logService.warn(
					`[ai] unable to read context resource ${item.uri.toString(true)}`,
					error,
				);
			}
		}
		return resolved;
	}

	// --- Persistence (JSONL, one session per line) ---

	private async restore(): Promise<void> {
		try {
			if (!(await this.fileService.exists(this.storageResource))) {
				return;
			}
			const content = await this.fileService.readFile(this.storageResource);
			for (const line of content.value.toString().split('\n')) {
				if (line.trim().length === 0) {
					continue;
				}
				const session = deserializeSession(line);
				if (session) {
					this.sessionsList.push(session);
				}
			}
			this.activeSessionId = this.sessionsList[0]?.id;
			if (this.sessionsList.length > 0) {
				this._onDidChange.fire(this.sessionsList[0]);
			}
		} catch (error) {
			// A corrupt history must never block startup; the user can start a new session.
			this.logService.error('[ai] unable to restore chat sessions', error);
		}
	}

	private async persist(): Promise<void> {
		const lines = this.sessionsList
			.slice(0, MAX_PERSISTED_SESSIONS)
			.map((session) => serializeSession(session));
		try {
			await this.fileService.createFolder(
				URI.joinPath(this.storageResource, '..'),
			);
			await this.fileService.writeFile(
				this.storageResource,
				VSBuffer.fromString(lines.join('\n')),
			);
		} catch (error) {
			this.logService.error('[ai] unable to persist chat sessions', error);
		}
	}
}

function serializeSession(session: ChatSession): string {
	return JSON.stringify({
		id: session.id,
		title: session.title,
		createdAt: session.createdAt,
		turns: session.turns.map((turn) => ({
			id: turn.id,
			role: turn.role,
			content: turn.content,
			createdAt: turn.createdAt,
			model: turn.model,
			error: turn.error,
			context: turn.context?.map((item) => ({
				kind: item.kind,
				label: item.label,
				uri: item.uri?.toString(),
				range: item.range,
			})),
		})),
	});
}

function deserializeSession(line: string): ChatSession | undefined {
	try {
		const raw = JSON.parse(line) as {
			id: string;
			title?: string;
			createdAt: number;
			turns?: {
				id: string;
				role: AIChatRole;
				content: string;
				createdAt: number;
				model?: string;
				error?: string;
				context?: {
					kind: AIChatContextKind;
					label: string;
					uri?: string;
					range?: IAIChatRange;
				}[];
			}[];
		};

		const session = new ChatSession(raw.id, raw.createdAt, raw.title);
		for (const turn of raw.turns ?? []) {
			session.turns.push({
				id: turn.id,
				role: turn.role,
				content: turn.content,
				createdAt: turn.createdAt,
				model: turn.model,
				error: turn.error,
				context: turn.context?.map((item) => ({
					kind: item.kind,
					label: item.label,
					uri: item.uri ? URI.parse(item.uri) : undefined,
					range: item.range,
				})),
			});
		}
		return session;
	} catch {
		return undefined;
	}
}

function extractRange(text: string, range: IAIChatRange): string {
	const lines = text.split('\n');
	const start = Math.max(1, range.startLineNumber) - 1;
	const end = Math.min(lines.length, range.endLineNumber);
	return lines.slice(start, end).join('\n');
}

registerSingleton(IAIChatService, AIChatService, InstantiationType.Delayed);
