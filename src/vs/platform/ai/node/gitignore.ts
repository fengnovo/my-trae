/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal `.gitignore` evaluation for the indexer walk. Supports comments, negation,
 * directory-only patterns, anchored patterns, `**` and the usual `*`/`?` wildcards.
 * Pure logic so it is unit testable without a filesystem.
 */

export interface IIgnoreRule {
	readonly pattern: RegExp;
	readonly negated: boolean;
	readonly directoryOnly: boolean;
	readonly base: string;
}

/** Directories that are never part of an index regardless of .gitignore contents. */
export const ALWAYS_IGNORED = new Set(['.git', 'node_modules']);

export function parseGitignore(content: string, base: string): IIgnoreRule[] {
	const rules: IIgnoreRule[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) {
			continue;
		}
		const negated = line.startsWith('!');
		const directoryOnly = line.endsWith('/');
		let pattern = line.replace(/^!/, '').replace(/\/$/, '');
		const anchored = pattern.startsWith('/');
		if (anchored) {
			pattern = pattern.slice(1);
		}
		if (pattern.length === 0) {
			continue;
		}
		rules.push({
			pattern: toRegExp(pattern, anchored || pattern.includes('/')),
			negated,
			directoryOnly,
			base,
		});
	}
	return rules;
}

function toRegExp(pattern: string, anchored: boolean): RegExp {
	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const character = pattern[i];
		if (character === '*') {
			if (pattern[i + 1] === '*') {
				// `**` spans directory separators; `/**/` also matches at the segment start.
				if (pattern[i + 2] === '/') {
					source += '(?:.*/)?';
					i += 2;
				} else {
					source += '.*';
					i++;
				}
			} else {
				source += '[^/]*';
			}
		} else if (character === '?') {
			source += '[^/]';
		} else {
			source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	// Unanchored patterns match at any depth, anchored ones only below their base.
	const prefix = anchored ? '' : '(?:.*/)?';
	return new RegExp(`^${prefix}${source}(/.*)?$`);
}

/**
 * A path matches when the pattern covers the path itself or one of its parent
 * directories (gitignore semantics: ignoring a directory ignores everything below it).
 * Later rules win, so negation of an earlier match works as documented.
 */
export function isIgnored(relativePath: string, isDirectory: boolean, rules: readonly IIgnoreRule[]): boolean {
	let ignored = false;
	const segments = relativePath.split('/');
	for (let i = 0; i < segments.length; i++) {
		const prefix = segments.slice(0, i + 1).join('/');
		const segmentIsDirectory = i < segments.length - 1 || isDirectory;
		for (const rule of rules) {
			if (!prefix.startsWith(rule.base)) {
				continue;
			}
			const local = prefix.slice(rule.base.length);
			if (local.length === 0) {
				continue;
			}
			if (rule.directoryOnly && !segmentIsDirectory) {
				continue;
			}
			if (rule.pattern.test(local)) {
				ignored = !rule.negated;
			}
		}
	}
	return ignored;
}
