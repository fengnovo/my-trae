/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const piAgentChannel = 'mytraePiAgent';
export type PiAgentMode = 'chat' | 'plan' | 'build';
export type PiToolName = 'read_file' | 'list_dir' | 'search_code' | 'get_diagnostics' | 'write_file' | 'edit_file' | 'run_terminal_command' | 'update_plan' | 'remember' | 'search_memory' | 'web_search' | 'web_fetch';

export interface IPiPlanStep {
	readonly id: string;
	readonly title: string;
	readonly status: 'pending' | 'in_progress' | 'completed';
}

export interface IPiToolArguments {
	readonly path?: string;
	readonly content?: string;
	readonly oldText?: string;
	readonly newText?: string;
	readonly command?: string;
	readonly query?: string;
	readonly url?: string;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly maxResults?: number;
	readonly title?: string;
	readonly steps?: readonly IPiPlanStep[];
}

export interface IPiToolRequest {
	readonly id: string;
	readonly name: PiToolName;
	readonly arguments: IPiToolArguments;
	readonly mode: PiAgentMode;
}

export interface IPiToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

export interface IPiTurn {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly pending?: boolean;
	readonly error?: string;
}

export interface IPiSessionInfo {
	readonly id: string;
	readonly path: string;
	readonly title: string;
	readonly updatedAt: number;
}

export interface IPiSnapshot {
	readonly session: IPiSessionInfo;
	readonly turns: readonly IPiTurn[];
	readonly isStreaming: boolean;
	readonly mode: PiAgentMode;
	readonly plan: readonly IPiPlanStep[];
}

export interface IPiHostConfiguration {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly endpoint: {
		readonly providerId: string;
		readonly api: 'openai-completions' | 'anthropic-messages';
		readonly baseUrl: string;
		readonly apiKey: string;
		readonly model: string;
		readonly contextWindow: number;
		readonly maxTokens: number;
	};
	readonly maxSteps: number;
}

/** Pi owns execution and persisted history; the IDE only projects snapshots and executes tools. */
export interface IPiAgentHost {
	readonly onDidChange: Event<IPiSnapshot>;
	readonly onDidRequestTool: Event<IPiToolRequest>;
	initialize(configuration: IPiHostConfiguration): Promise<IPiSnapshot>;
	prompt(input: { text: string; context?: string; mode: PiAgentMode }): Promise<void>;
	abort(): Promise<void>;
	listSessions(): Promise<readonly IPiSessionInfo[]>;
	openSession(path: string): Promise<IPiSnapshot>;
	newSession(): Promise<IPiSnapshot>;
	deleteSession(path: string): Promise<void>;
	completeTool(input: { id: string; result: IPiToolResult }): Promise<void>;
	fetchWeb(input: { url: string }): Promise<string>;
}

export const IPiAgentService = createDecorator<IPiAgentService>('mytraePiAgentService');

/** Desktop proxy: configuration, process lifecycle, and reverse IDE-tool calls. */
export interface IPiAgentService extends IPiAgentHost {
	readonly _serviceBrand: undefined;
	rollback(): Promise<void>;
}
