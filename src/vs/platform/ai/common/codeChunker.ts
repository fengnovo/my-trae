/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structure-aware chunking for the code index. Splits source at top-level declarations
 * (brace tracking for brace languages, indentation for Python) so chunks align with
 * functions and classes. Falls back to a sliding window for unstructured or oversized
 * regions. Pure string logic: no node or editor dependencies.
 */

export interface ICodeChunk {
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

const MAX_CHUNK_LINES = 90;
const FALLBACK_OVERLAP = 8;
const MIN_CHUNK_LINES = 4;

/** Languages chunked by brace depth, everything else by indentation or plain window. */
const BRACE_LANGUAGES = new Set([
	'typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'json', 'css', 'scss', 'less', 'c', 'cpp', 'csharp', 'go', 'java', 'rust', 'swift', 'kotlin', 'php',
]);

interface ILine {
	readonly text: string;
	/** Net brace delta of the line (opens minus closes), ignoring literals. */
	readonly delta: number;
	readonly indent: number;
}

export function chunkSourceCode(text: string, languageId: string): ICodeChunk[] {
	const normalized = text.replace(/\r\n?/g, '\n');
	const lines = toLines(normalized);
	if (lines.length === 0) {
		return [];
	}
	const chunks = BRACE_LANGUAGES.has(languageId)
		? chunkByBraces(lines)
		: chunkByIndentation(lines, languageId);
	if (chunks.length === 0) {
		return chunkByWindow(lines, 0, lines.length);
	}
	return chunks;
}

function toLines(text: string): ILine[] {
	return text.split('\n').map(text => {
		const stripped = stripLiterals(text);
		let delta = 0;
		for (const character of stripped) {
			if (character === '{') { delta++; }
			else if (character === '}') { delta--; }
		}
		const trimmed = text.trimStart();
		return { text, delta, indent: text.length - trimmed.length };
	});
}

/** Removes string and comment contents so braces inside literals do not confuse depth. */
function stripLiterals(line: string): string {
	let result = '';
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const character = line[i];
		if (quote) {
			if (character === '\\') { i++; continue; }
			if (character === quote) { quote = undefined; }
			continue;
		}
		if (character === '"' || character === '\'' || character === '`') {
			quote = character;
			continue;
		}
		if (character === '/' && line[i + 1] === '/') { break; }
		result += character;
	}
	return result;
}

/** Splits at depth 0 -> 1 transitions and keeps loose lines as window chunks. */
function chunkByBraces(lines: ILine[]): ICodeChunk[] {
	const chunks: ICodeChunk[] = [];
	let loose: number[] = [];
	let depth = 0;
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const before = depth;
		depth += lines[i].delta;
		if (before === 0 && depth > 0 && start === -1) {
			if (loose.length >= MIN_CHUNK_LINES) {
				chunks.push(...chunkByWindow(lines, loose[0], i));
			} else if (loose.length > 0 && chunks.length > 0) {
				// Attach a small leading prologue to the following block for context.
				start = loose[0];
			}
			if (start === -1) { start = i; }
			loose = [];
		} else if (depth <= 0 && start !== -1) {
			const end = Math.min(i + 1, lines.length);
			chunks.push(...bounded(lines, start, end));
			start = -1;
			depth = 0;
			loose = [];
		} else if (start === -1) {
			loose.push(i);
		}
	}
	if (start !== -1) {
		chunks.push(...bounded(lines, start, lines.length));
	} else if (loose.length >= MIN_CHUNK_LINES) {
		chunks.push(...chunkByWindow(lines, loose[0], lines.length));
	}
	return mergeTiny(chunks, lines);
}

/** Top-level `def`/`class` boundaries for Python; other indentation languages fall back. */
function chunkByIndentation(lines: ILine[], languageId: string): ICodeChunk[] {
	if (languageId !== 'python') {
		return [];
	}
	const chunks: ICodeChunk[] = [];
	let loose: number[] = [];
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (start !== -1) {
			const blank = line.text.trim().length === 0;
			if (!blank && line.indent === 0) {
				chunks.push(...bounded(lines, start, i));
				start = /^((async\s+)?def|class)\b/.test(line.text.trim()) ? i : -1;
				if (start === -1) { loose.push(i); }
			}
		} else if (line.indent === 0 && /^((async\s+)?def|class)\b/.test(line.text.trim())) {
			if (loose.length >= MIN_CHUNK_LINES) {
				chunks.push(...chunkByWindow(lines, loose[0], i));
			} else if (loose.length > 0) {
				start = loose[0];
				loose = [];
			}
			if (start === -1) { start = i; }
			loose = [];
		} else {
			loose.push(i);
		}
	}
	if (start !== -1) {
		chunks.push(...bounded(lines, start, lines.length));
	} else if (loose.length >= MIN_CHUNK_LINES) {
		chunks.push(...chunkByWindow(lines, loose[0], lines.length));
	}
	return mergeTiny(chunks, lines);
}

/** Window split used for loose (unstructured) line runs. */
function chunkByWindow(lines: ILine[], from: number, to: number): ICodeChunk[] {
	return bounded(lines, from, to);
}

/** Applies the window split with overlap to any region larger than one chunk. */
function bounded(lines: ILine[], from: number, to: number): ICodeChunk[] {
	if (to - from <= MAX_CHUNK_LINES) {
		return [slice(lines, from, to)];
	}
	const chunks: ICodeChunk[] = [];
	let start = from;
	while (start < to) {
		const end = Math.min(start + MAX_CHUNK_LINES, to);
		if (to - end < MIN_CHUNK_LINES) {
			chunks.push(slice(lines, start, to));
			break;
		}
		chunks.push(slice(lines, start, end));
		if (end >= to) { break; }
		start = Math.max(end - FALLBACK_OVERLAP, start + 1);
	}
	return chunks;
}

function slice(lines: ILine[], from: number, to: number): ICodeChunk {
	const text = lines.slice(from, to).map(line => line.text).join('\n').replace(/\s+$/, '');
	return { startLine: from + 1, endLine: to, text };
}

/** Folds tiny chunks into the previous one so the store does not fill with stubs. */
function mergeTiny(chunks: ICodeChunk[], lines: ILine[]): ICodeChunk[] {
	const merged: ICodeChunk[] = [];
	for (const chunk of chunks) {
		const previous = merged.at(-1);
		const size = chunk.endLine - chunk.startLine + 1;
		if (
			size < MIN_CHUNK_LINES && previous &&
			chunk.startLine - previous.endLine <= 8 &&
			chunk.endLine - previous.startLine + 1 <= MAX_CHUNK_LINES
		) {
			const from = previous.startLine - 1;
			merged[merged.length - 1] = slice(lines, from, chunk.endLine);
			continue;
		}
		merged.push(chunk);
	}
	return merged;
}
