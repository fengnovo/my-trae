/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAIStreamResponse, IAITransport } from '../../common/aiTransport.js';

/**
 * Test doubles for the LLM transport. They keep the provider tests free of the request
 * service, sockets and timers so that wire format handling stays deterministic.
 */

export interface IFakeRequest {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: string;
}

const encoder = new TextEncoder();

/** Response whose body is delivered as the given raw chunks. */
export function chunkedResponse(
	chunks: readonly Uint8Array[],
	statusCode = 200,
): IAIStreamResponse {
	return {
		statusCode,
		headers: {},
		chunks: (async function* () {
			for (const chunk of chunks) {
				yield chunk;
			}
		})(),
	};
}

/** Response delivering `body` in a single chunk. */
export function textResponse(
	body: string,
	statusCode = 200,
): IAIStreamResponse {
	return chunkedResponse([encoder.encode(body)], statusCode);
}

/** Joins SSE frames, adding the blank line terminator when the caller left it out. */
export function sseBody(frames: readonly string[]): string {
	return frames
		.map((frame) => (frame.endsWith('\n\n') ? frame : `${frame}\n\n`))
		.join('');
}

/** `data: <payload>` frame. */
export function dataFrame(payload: string): string {
	return `data: ${payload}\n\n`;
}

/** `event: <type>` + `data: <payload>` frame, as used by the Anthropic API. */
export function typedFrame(type: string, payload: string): string {
	return `event: ${type}\ndata: ${payload}\n\n`;
}

/** Transport recording every request and answering with whatever the responder returns. */
export class FakeTransport implements IAITransport {
	readonly requests: IFakeRequest[] = [];

	constructor(
		private readonly responder: (request: IFakeRequest) => IAIStreamResponse,
	) {}

	async post(
		url: string,
		headers: Record<string, string>,
		body: string,
		_token: AbortSignal,
	): Promise<IAIStreamResponse> {
		const request: IFakeRequest = { url, headers, body };
		this.requests.push(request);
		return this.responder(request);
	}

	get lastRequest(): IFakeRequest {
		if (this.requests.length === 0) {
			throw new Error('no request was issued');
		}
		return this.requests[this.requests.length - 1];
	}

	/** Body of the last request, parsed. Loosely typed because every provider sends a different shape. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	get lastBody(): any {
		return JSON.parse(this.lastRequest.body);
	}
}

/** Collects an async iterable into an array. */
export async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) {
		result.push(item);
	}
	return result;
}

export function newSignal(): AbortSignal {
	return new AbortController().signal;
}
