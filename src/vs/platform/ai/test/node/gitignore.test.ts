/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isIgnored, parseGitignore } from '../../node/gitignore.js';

suite('Gitignore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('skips comments and blank lines', () => {
		assert.deepStrictEqual(parseGitignore('# comment\n\n   \n', ''), []);
	});

	test('matches unanchored patterns at any depth', () => {
		const rules = parseGitignore('dist\n', '');
		assert.deepStrictEqual(
			{
				root: isIgnored('dist/x.js', false, rules),
				nested: isIgnored('a/b/dist/x.js', false, rules),
				nestedDir: isIgnored('a/b/dist', true, rules),
				prefix: isIgnored('distribution/readme.md', false, rules),
			},
			{ root: true, nested: true, nestedDir: true, prefix: false },
		);
	});

	test('anchors patterns that start with a slash', () => {
		const rules = parseGitignore('/build\n', '');
		assert.deepStrictEqual(
			{ root: isIgnored('build/out.js', false, rules), nested: isIgnored('src/build/out.js', false, rules) },
			{ root: true, nested: false },
		);
	});

	test('directory-only patterns do not match files', () => {
		const rules = parseGitignore('logs/\n', '');
		assert.deepStrictEqual(
			{
				directory: isIgnored('logs', true, rules),
				file: isIgnored('logs', false, rules),
				inside: isIgnored('logs/a.txt', false, rules),
			},
			{ directory: true, file: false, inside: true },
		);
	});

	test('later negation wins over earlier matches', () => {
		const rules = parseGitignore('*.ts\n!keep.ts\n', '');
		assert.deepStrictEqual(
			{ generated: isIgnored('gen/a.ts', false, rules), kept: isIgnored('keep.ts', false, rules) },
			{ generated: true, kept: false },
		);
	});

	test('double asterisks span directories', () => {
		const rules = parseGitignore('**/vendor/**\n', '');
		assert.deepStrictEqual(
			{ nested: isIgnored('libs/vendor/x.js', false, rules), outside: isIgnored('libs/other/x.js', false, rules) },
			{ nested: true, outside: false },
		);
	});

	test('nested gitignores only apply below their base', () => {
		const rules = parseGitignore('target/\n', 'packages/app');
		assert.deepStrictEqual(
			{
				inside: isIgnored('packages/app/target/debug.js', false, rules),
				elsewhere: isIgnored('other/target/debug.js', false, rules),
			},
			{ inside: true, elsewhere: false },
		);
	});
});
