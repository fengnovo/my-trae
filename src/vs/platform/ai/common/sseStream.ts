/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SSEParser, type ISSEEvent } from '../../../base/common/sseParser.js';
import { IAIStreamResponse, readResponseText } from './aiTransport.js';

/**
 * Turns a raw HTTP response into a sequence of SSE events. Shared by all providers so
 * that framing, UTF-8 chunk splitting and cancellation behave identically everywhere.
 *
 * The generator stops as soon as the consumer breaks out of the loop, which is what
 * lets callers abort a long completion without draining the remaining tokens.
 */
export async function* sseEvents(
	response: IAIStreamResponse,
	token: AbortSignal,
): AsyncIterable<ISSEEvent> {
	// The base parser is callback driven; events are handed over through a small queue
	// so that the generator can preserve backpressure.
	const queue: ISSEEvent[] = [];
	let wake: (() => void) | undefined;
	const parser = new SSEParser((event) => {
		queue.push(event);
		wake?.();
	});

	let ended = false;
	let failure: unknown;
	const pump = (async () => {
		try {
			for await (const chunk of response.chunks) {
				if (token.aborted) {
					return;
				}
				parser.feed(chunk);
			}
		} catch (error) {
			failure = error;
		} finally {
			ended = true;
			wake?.();
		}
	})();

	try {
		while (true) {
			// Checked first so that cancelling takes effect immediately, even when a single
			// network chunk already delivered several events into the queue.
			if (token.aborted) {
				return;
			}
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (failure !== undefined) {
				throw failure;
			}
			if (ended) {
				return;
			}
			await new Promise<void>((resolve) => (wake = resolve));
			wake = undefined;
		}
	} finally {
		// Make sure the pump does not keep the request alive after the consumer is gone.
		void pump.catch(() => undefined);
	}
}

/**
 * Reads a non-2xx response and converts it into a provider agnostic error.
 * `extractMessage` lets each provider family apply its own error envelope.
 */
export async function readErrorResponse(
	response: IAIStreamResponse,
	extractMessage: (body: string) => string | undefined,
	createError: (message: string, statusCode: number | undefined) => Error,
): Promise<Error> {
	const body = await readResponseText(response);
	const message = extractMessage(body);
	return createError(
		message && message.length > 0 ? message : body.trim(),
		response.statusCode,
	);
}
