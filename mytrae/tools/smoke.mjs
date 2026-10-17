/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// The supplied app must use an isolated, disposable profile. This check opens its AI view.
const endpoint = process.argv[2];
if (!endpoint) {
	throw new Error('Usage: node mytrae/tools/smoke.mjs <CDP URL> [screenshot.png]');
}
const browser = await chromium.connectOverCDP(endpoint);
try {
	const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('/workbench'));
	assert.ok(page, 'The Electron workbench target must exist');
	const startupErrors = [];
	page.on('pageerror', error => startupErrors.push(error.message));
	page.on('console', message => {
		if (message.type() === 'error' && /TypeError:|ReferenceError:|Cannot register two commands|Unknown service/.test(message.text())) {
			startupErrors.push(message.text());
		}
	});
	await page.reload();
	await page.locator('.monaco-workbench .part.editor').waitFor({ state: 'visible', timeout: 15000 });
	await page.bringToFront();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
	const input = page.locator('.quick-input-widget input');
	await input.fill('>Focus AI Chat');
	await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Focus AI Chat' }).first().waitFor({ state: 'visible' });
	await page.keyboard.press('Enter');
	await page.locator('.mytrae-chat-root').waitFor({ state: 'visible', timeout: 15000 });
	assert.deepStrictEqual(startupErrors, [], 'The workbench must start without service or registration errors');
	if (process.argv[3]) {
		await page.screenshot({ path: process.argv[3] });
	}
	console.log(JSON.stringify({ title: await page.title(), url: page.url(), workbench: 'visible', aiChat: 'visible' }));
} finally {
	await browser.close();
}
