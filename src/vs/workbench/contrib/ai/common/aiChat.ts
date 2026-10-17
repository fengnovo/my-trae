/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IPiPlanStep, PiAgentMode } from '../../../../platform/ai/common/piAgent.js';

/**
 * Chat domain types. Deliberately independent of the LLM wire format so that the panel,
 * the persistence layer and the agent can share one model of a conversation.
 */

/**
 * Editor range shape. Declared locally so that `common` stays free of editor layer
 * imports; structurally compatible with `IRange` from the editor.
 */
export interface IAIChatRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export const enum AIChatRole {
	System = 'system',
	User = 'user',
	Assistant = 'assistant',
	Tool = 'tool',
}

export interface IAIChatTurn {
	readonly id: string;
	readonly role: AIChatRole;
	content: string;
	readonly createdAt: number;
	readonly model?: string;
	/** True while the assistant turn is still receiving tokens. */
	pending?: boolean;
	/** Set when the turn failed; the content holds the error message. */
	error?: string;
	/** Context references attached to a user turn, kept for display and re-send. */
	readonly context?: readonly IAIChatContextItem[];
}

export const enum AIChatContextKind {
	File = 'file',
	Selection = 'selection',
	Codebase = 'codebase',
}

export interface IAIChatContextItem {
	readonly kind: AIChatContextKind;
	readonly label: string;
	readonly uri?: URI;
	readonly range?: IAIChatRange;
	/** Resolved snippet, filled in when the turn is sent. */
	readonly text?: string;
}

export interface IAIChatSession {
	readonly id: string;
	title: string;
	readonly createdAt: number;
	readonly turns: IAIChatTurn[];
}

export const IAIChatService = createDecorator<IAIChatService>('aiChatService');

export interface IAIChatService {
	readonly _serviceBrand: undefined;

	/** Fires whenever a session or one of its turns changed. */
	readonly onDidChange: Event<IAIChatSession>;

	readonly sessions: readonly IAIChatSession[];
	readonly activeSession: IAIChatSession | undefined;
	readonly isStreaming: boolean;
	readonly mode?: PiAgentMode;
	readonly plan?: readonly IPiPlanStep[];
	readonly initializationError?: string;
	readonly ready?: Promise<void>;
	setMode?(mode: PiAgentMode): void;
	rollback?(): Promise<void>;

	createSession(): IAIChatSession | Promise<IAIChatSession>;
	setActiveSession(sessionId: string): void | Promise<void>;
	deleteSession(sessionId: string): Promise<void>;

	/** Appends a user turn and streams the assistant reply into the session. */
	send(text: string, context: readonly IAIChatContextItem[]): Promise<void>;
	cancel(): void;
}
