/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClientRequest, IncomingMessage, RequestOptions } from 'http';
import { isIP } from 'net';

interface IFetchDependencies {
	resolve(hostname: string): Promise<readonly string[]>;
	request(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
}

/** Reject non-public IPv4 ranges, including metadata, loopback and reserved networks. */
function publicAddress(address: string): boolean {
	if (isIP(address) !== 4) { return false; }
	const [a, b, c] = address.split('.').map(Number);
	return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

/** Fetch public web text with DNS validation and an address pinned to the same connection. */
export async function fetchPiWeb(input: string, signal?: AbortSignal, dependencies?: IFetchDependencies): Promise<string> {
	const url = new URL(input);
	if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname || url.hostname.includes(':') || url.hostname.startsWith('[')) { throw new Error('Web fetch requires an HTTP(S) URL without credentials and a public IPv4 host'); }
	if (isIP(url.hostname) && !publicAddress(url.hostname)) { throw new Error('Web fetch requires a public IPv4 address'); }
	const controller = new AbortController();
	const cancel = () => controller.abort(signal?.reason);
	signal?.addEventListener('abort', cancel, { once: true });
	if (signal?.aborted) { cancel(); }
	const timeout = setTimeout(() => controller.abort(new Error('Web fetch timed out after 15 seconds')), 15000);
	let cancelResolution: (() => void) | undefined;
	try {
		if (controller.signal.aborted) { throw new Error('Web fetch aborted'); }
		const resolver = dependencies?.resolve ?? (async (hostname: string) => {
			const { lookup } = await import('dns/promises');
			return (await lookup(hostname, { family: 4, all: true, verbatim: true })).map(answer => answer.address);
		});
		const addresses = await Promise.race([
			isIP(url.hostname) ? Promise.resolve([url.hostname]) : resolver(url.hostname),
			new Promise<never>((_resolve, reject) => {
				cancelResolution = () => reject(new Error('Web fetch aborted during DNS resolution'));
				controller.signal.addEventListener('abort', cancelResolution, { once: true });
			}),
		]);
		if (!addresses.length || addresses.some(address => !publicAddress(address))) { throw new Error('Web fetch requires every DNS answer to be a public IPv4 address'); }
		if (controller.signal.aborted) { throw new Error('Web fetch aborted'); }
		const request = dependencies?.request ?? (url.protocol === 'https:' ? (await import('https')).request : (await import('http')).request);
		return await new Promise<string>((resolveResult, reject) => {
			const connection = request(url, {
				method: 'GET', family: 4, signal: controller.signal,
				headers: { Accept: 'text/html, text/plain, application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'MyTrae-Web-Fetch' },
				// Never resolve the hostname a second time: DNS rebinding cannot change this peer.
				lookup: (_hostname, _options, callback) => callback(null, addresses[0], 4),
			}, response => {
				if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
					response.destroy();
					reject(new Error(`Web fetch returned HTTP ${response.statusCode}; redirects are disabled`));
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on('data', (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > 512 * 1024) { response.destroy(new Error('Web response exceeds 512 KB')); return; }
					chunks.push(chunk);
				});
				response.once('error', reject);
				response.once('end', () => resolveResult(Buffer.concat(chunks).toString('utf8').slice(0, 32000)));
			});
			connection.once('error', reject);
			connection.end();
		});
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', cancel);
		if (cancelResolution) { controller.signal.removeEventListener('abort', cancelResolution); }
	}
}
