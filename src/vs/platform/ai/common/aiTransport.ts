/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	VSBuffer,
	type VSBufferReadableStream,
} from '../../../base/common/buffer.js';
import {
	CancellationTokenSource,
	type CancellationToken,
} from '../../../base/common/cancellation.js';
import { listenStream } from '../../../base/common/stream.js';
import { type IHeaders } from '../../../base/parts/request/common/request.js';
import {
	IRequestService,
	NO_FETCH_TELEMETRY,
} from '../../request/common/request.js';

/**
 * HTTP transport for LLM endpoints. Wraps the platform request service so that proxy
 * settings, TLS configuration and offline detection keep working exactly as they do for
 * the rest of the product, while exposing the response as an async iterable of raw
 * byte chunks suitable for incremental SSE parsing.
 */

export interface IAIStreamResponse {
	readonly statusCode: number;
	readonly headers: IHeaders;
	/** Raw chunks. Chunk boundaries may split multi-byte UTF-8 sequences. */
	readonly chunks: AsyncIterable<Uint8Array>;
}

export interface IAITransport {
	post(
		url: string,
		headers: Record<string, string>,
		body: string,
		token: AbortSignal,
	): Promise<IAIStreamResponse>;
}

export class RequestServiceTransport implements IAITransport {
	constructor(
		@IRequestService private readonly requestService: IRequestService,
	) {}

	async post(
		url: string,
		headers: Record<string, string>,
		body: string,
		token: AbortSignal,
	): Promise<IAIStreamResponse> {
		// Scoped to a single request: the cancellation source and the abort listener are
		// released when the response stream is drained or abandoned, not when the transport dies.
		const cts = new CancellationTokenSource();
		const abortListener = () => cts.cancel();
		if (token.aborted) {
			cts.cancel();
		} else {
			token.addEventListener('abort', abortListener, { once: true });
		}

		let context;
		try {
			context = await this.requestService.request(
				{
					type: 'POST',
					url,
					headers,
					data: body,
					timeout: 0,
					callSite: NO_FETCH_TELEMETRY,
				},
				cts.token,
			);
		} catch (error) {
			token.removeEventListener('abort', abortListener);
			cts.dispose();
			throw error;
		}

		return {
			statusCode: context.res.statusCode ?? 0,
			headers: context.res.headers,
			chunks: decodeChunks(context.stream, cts.token, () => {
				token.removeEventListener('abort', abortListener);
				cts.dispose();
			}),
		};
	}
}

async function* decodeChunks(
	stream: VSBufferReadableStream,
	token: CancellationToken,
	release: () => void,
): AsyncIterable<Uint8Array> {
	const pending: Uint8Array[] = [];
	let ended = false;
	let failure: unknown;
	let wake: (() => void) | undefined;

	try {
		listenStream<VSBuffer>(
			stream,
			{
				onData: (data) => {
					pending.push(data.buffer);
					wake?.();
				},
				onError: (error) => {
					failure = error;
					ended = true;
					wake?.();
				},
				onEnd: () => {
					ended = true;
					wake?.();
				},
			},
			token,
		);

		while (true) {
			if (pending.length > 0) {
				yield pending.shift()!;
				continue;
			}
			if (failure !== undefined) {
				throw failure;
			}
			if (ended || token.isCancellationRequested) {
				return;
			}
			await new Promise<void>((resolve) => (wake = resolve));
			wake = undefined;
		}
	} finally {
		// Runs when the consumer drains the stream, breaks out of the loop or hits an error.
		release();
	}
}

/** Collects a whole response body as text. Used for non-2xx error payloads. */
export async function readResponseText(
	response: IAIStreamResponse,
): Promise<string> {
	const decoder = new TextDecoder('utf-8');
	let text = '';
	for await (const chunk of response.chunks) {
		text += decoder.decode(chunk, { stream: true });
	}
	return text + decoder.decode();
}
