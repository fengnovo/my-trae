/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { exactPiEdit, piWorkspaceResource, validatePiWebUrl, assertPiToolAllowed } from '../../common/piToolPolicy.js';

suite('Pi tool policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const root = URI.file('/project');

	test('rejects traversal, external absolute paths and URI injection', () => {
		for (const path of ['../secret', '/elsewhere/file', 'file:///etc/passwd', 'a/../../secret', '..\\secret']) {
			assert.throws(() => piWorkspaceResource(root, path));
		}
		assert.strictEqual(piWorkspaceResource(root, 'src/a.ts').path, '/project/src/a.ts');
	});

	test('exact edits reject missing and duplicate matches', () => {
		assert.throws(() => exactPiEdit('foo foo', 'foo', 'bar'));
		assert.throws(() => exactPiEdit('foo', 'missing', 'bar'));
		assert.throws(() => exactPiEdit('foo', '', 'bar'));
		assert.strictEqual(exactPiEdit('a foo z', 'foo', 'bar'), 'a bar z');
	});

	test('plan/chat and untrusted workspaces cannot execute mutations', () => {
		assert.throws(() => assertPiToolAllowed('write_file', 'plan', true));
		assert.throws(() => assertPiToolAllowed('run_terminal_command', 'chat', true));
		assert.throws(() => assertPiToolAllowed('remember', 'plan', true));
		assert.throws(() => assertPiToolAllowed('read_file', 'build', false));
		assert.doesNotThrow(() => assertPiToolAllowed('write_file', 'build', true));
	});

	test('rejects local, metadata, non-http and credential-bearing web targets', () => {
		for (const url of ['file:///etc/passwd', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://10.1.2.3', 'http://169.254.169.254/latest', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://metadata.google.internal', 'https://user:pass@example.com', 'http://192.168.1.1', 'http://100.64.0.1']) {
			assert.throws(() => validatePiWebUrl(url), url);
		}
		assert.strictEqual(validatePiWebUrl('https://example.com/a').protocol, 'https:');
	});
});
