/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Server } from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { fetchPiWeb } from '../../node/piWebFetch.js';

suite('Pi pinned web fetch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let server: Server;
	let baseUrl: string;
	let redirects = 0;

	setup(async () => {
		const { createServer } = await import('http');
		redirects = 0;
		server = createServer((request, response) => {
			if (request.url === '/redirect') { response.writeHead(302, { Location: `${baseUrl}/target` }); response.end(); }
			else if (request.url === '/target') { redirects++; response.end('redirect target'); }
			else if (request.url === '/large') { response.end('x'.repeat(512 * 1024 + 1)); }
			else if (request.url === '/pending') { response.writeHead(200); response.write('waiting'); }
			else { response.end('x'.repeat(40000)); }
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert(address && typeof address === 'object');
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	teardown(async () => {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	test('rejects local, reserved, IPv6 and credentials before opening a socket', async () => {
		for (const url of ['http://127.0.0.1', 'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.0.1', 'http://169.254.169.254', 'http://100.64.0.1', 'http://[::1]', 'http://user:password@example.com', 'file:///etc/passwd']) {
			await assert.rejects(fetchPiWeb(url));
		}
	});

	test('rejects a hostname if any DNS answer is private', async () => {
		await assert.rejects(fetchPiWeb('https://public.example', undefined, { resolve: async () => ['8.8.8.8', '127.0.0.1'], request: () => { throw new Error('request must not run'); } }), /public IPv4/);
	});

	test('pins the validated DNS answer and bounds the returned text', async () => {
		const { request } = await import('http');
		const pinned: string[] = [];
		const text = await fetchPiWeb('http://public.example/', undefined, {
			resolve: async () => ['8.8.8.8'],
			request: (url, options, callback) => {
				assert(options.lookup);
				options.lookup(url.hostname, {}, (_error, address) => { if (typeof address === 'string') { pinned.push(address); } });
				return request(`${baseUrl}${url.pathname}`, { signal: options.signal }, callback);
			},
		});
		assert.deepStrictEqual({ pinned, length: text.length }, { pinned: ['8.8.8.8'], length: 32000 });
	});

	test('rejects redirects and oversized streamed responses and cancels pending responses', async () => {
		const { request } = await import('http');
		const dependencies = { resolve: async () => ['8.8.8.8'], request: (url: URL, options: import('http').RequestOptions, callback: (response: import('http').IncomingMessage) => void) => request(`${baseUrl}${url.pathname}`, { signal: options.signal }, callback) };
		await assert.rejects(fetchPiWeb('http://public.example/redirect', undefined, dependencies), /302/);
		await assert.rejects(fetchPiWeb('http://public.example/large', undefined, dependencies), /512/);
		const controller = new AbortController();
		const pending = fetchPiWeb('http://public.example/pending', controller.signal, dependencies);
		controller.abort();
		await assert.rejects(pending);
		assert.strictEqual(redirects, 0);
	});
});
