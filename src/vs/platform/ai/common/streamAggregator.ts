/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILLMResponse, ILLMStreamChunk, ILLMToolCall } from './ai.js';

/**
 * Collects a streamed response into a single result. Used by non-streaming callers and
 * by the agent loop, which needs the complete tool call list before it can execute.
 */
export async function aggregateStream(
	chunks: AsyncIterable<ILLMStreamChunk>,
): Promise<ILLMResponse> {
	let content = '';
	let finishReason: ILLMResponse['finishReason'];
	let usage: ILLMResponse['usage'];
	const toolCalls = new Map<
		number,
		{ id: string; name: string; args: string }
	>();

	for await (const chunk of chunks) {
		if (chunk.textDelta) {
			content += chunk.textDelta;
		}
		if (chunk.finishReason !== undefined) {
			finishReason = chunk.finishReason;
		}
		if (chunk.usage) {
			usage = {
				promptTokens: chunk.usage.promptTokens ?? usage?.promptTokens,
				completionTokens:
					chunk.usage.completionTokens ?? usage?.completionTokens,
			};
		}
		if (chunk.toolCallDeltas) {
			for (const delta of chunk.toolCallDeltas) {
				const entry = toolCalls.get(delta.index) ?? {
					id: '',
					name: '',
					args: '',
				};
				if (delta.id) {
					entry.id = delta.id;
				}
				if (delta.nameDelta) {
					entry.name += delta.nameDelta;
				}
				if (delta.argumentsDelta) {
					entry.args += delta.argumentsDelta;
				}
				toolCalls.set(delta.index, entry);
			}
		}
	}

	const calls: ILLMToolCall[] = [];
	for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
		const entry = toolCalls.get(index)!;
		if (entry.name.length > 0 || entry.args.length > 0) {
			calls.push({ id: entry.id, name: entry.name, arguments: entry.args });
		}
	}

	return { content, toolCalls: calls, finishReason, usage };
}
