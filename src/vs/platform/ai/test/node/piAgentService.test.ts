/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Server, ServerResponse } from 'http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IPiHostConfiguration, IPiSnapshot, IPiToolRequest } from '../../common/piAgent.js';
import { PiAgentService } from '../../node/piAgentService.js';

interface ModelRequest {
	reasoning_effort?: string;
	max_tokens?: number;
	stream_options?: { include_usage?: boolean };
	messages: { role: string; content?: string | { type: string; text?: string }[]; tool_calls?: { function: { name: string } }[] }[];
	tools?: { function: { name: string } }[];
}

suite('PiAgentService (real Pi SDK)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let directory: string;
	let server: Server;
	let service: PiAgentService;
	let configuration: IPiHostConfiguration;
	let requests: ModelRequest[];
	let snapshots: IPiSnapshot[];
	let calls: IPiToolRequest[];
	let blockTools: boolean;
	let toolError: boolean;
	let commandFailure: boolean;
	let capacityAvailable: boolean;

	const respond = async (response: ServerResponse, chunks: object[], finishReason: string) => {
		response.writeHead(200, { 'Content-Type': 'text/event-stream' });
		for (const delta of chunks) {
			if (response.destroyed) { return; }
			response.write(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
			await new Promise(resolve => setTimeout(resolve, 3));
		}
		response.end(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
	};

	setup(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mytrae-pi-'));
		requests = [];
		snapshots = [];
		calls = [];
		blockTools = false;
		toolError = false;
		commandFailure = false;
		capacityAvailable = true;
		const { createServer } = await import('http');
		server = createServer(async (request, response) => {
			if (request.url === '/api/ps') {
				response.writeHead(capacityAvailable ? 200 : 404, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ models: [{ name: 'test-model:latest', context_length: 4096 }] }));
				return;
			}
			let body = '';
			for await (const chunk of request) { body += chunk; }
			const input = JSON.parse(body) as ModelRequest;
			requests.push(input);
			const user = input.messages.filter(message => message.role === 'user').at(-1);
			const text = typeof user?.content === 'string' ? user.content : user?.content?.map(block => block.text ?? '').join('\n') ?? '';
			const hasResult = input.messages.some(message => message.role === 'tool');
			const buildScenario = input.messages.some(message => JSON.stringify(message.content).includes('prose after inspection'));
			if (input.messages.some(message => JSON.stringify(message.content).includes('recover command failure'))) {
				const results = input.messages.filter(message => message.role === 'tool').length;
				const checked = input.messages.filter(message => message.role === 'user').length > 1;
				if (results === 0 || (results === 1 && checked && !input.messages.some(message => JSON.stringify(message.content).includes('stalled recovery')))) {
					const name = results === 0 ? 'run_terminal_command' : 'write_file';
					await respond(response, [{ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'run_terminal_command' ? { command: 'vite create blog' } : { path: 'index.html', content: 'Blog' }) } }] }], 'tool_calls');
				} else { await respond(response, [{ role: 'assistant', content: results === 1 ? 'I will create files manually.' : 'Created the page.' }], 'stop'); }
			} else if (buildScenario) {
				const results = input.messages.filter(message => message.role === 'tool').length;
				const checked = input.messages.filter(message => message.role === 'user').length > 1;
				if (results === 0 || (results === 1 && checked)) {
					const name = results === 0 ? 'list_dir' : 'write_file';
					const args = name === 'list_dir' ? {} : { path: 'index.html', content: '<!doctype html><title>Blog</title>' };
					await respond(response, [{ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }], 'tool_calls');
				} else { await respond(response, [{ role: 'assistant', content: results === 1 ? 'I will create the page now.' : 'The page has been created.' }], 'stop'); }
			} else if (text === 'truncated implementation') {
				await respond(response, [{ role: 'assistant', content: 'Next I will create CSS:' }], 'length');
			} else if (text?.includes('reasoning only') || (text?.includes('ollama greeting') && input.reasoning_effort !== 'none')) {
				await respond(response, [{ role: 'assistant', reasoning_content: 'Internal reasoning without an answer' }], 'stop');
			} else if (text?.includes('broken stream')) {
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				response.end('data: [DONE]\n\n');
			} else if (text === 'mutation then prose' && !hasResult) {
				await respond(response, [{ role: 'assistant', tool_calls: [{ index: 0, id: 'write-once', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: 'Blog' }) } }] }], 'tool_calls');
			} else if (/^(?:use|repeat|forbidden|repeat forbidden|plan) tool$/.test(text ?? '') && (!hasResult || text?.includes('repeat')) && requests.length < 6) {
				const name = text.includes('plan') ? 'update_plan' : text.includes('forbidden') ? 'write_file' : 'read_file';
				const args = name === 'update_plan' ? { steps: [{ id: 'first', title: 'Inspect project', status: 'in_progress' }] } : { path: 'README.md', content: 'changed' };
				await respond(response, [{ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }], 'tool_calls');
			} else {
				await respond(response, [{ role: 'assistant', content: 'Hello' }, { content: ' from Pi' }], 'stop');
			}
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert(address && typeof address === 'object');
		configuration = { cwd: directory, agentDir: join(directory, 'agent'), sessionDir: join(directory, 'sessions'), maxSteps: 2, endpoint: { providerId: 'mytrae-test', api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'in-memory-secret', model: 'test-model', contextWindow: 32768, maxTokens: 1024 } };
		service = disposables.add(new PiAgentService());
		disposables.add(service.onDidChange(snapshot => snapshots.push(snapshot)));
		disposables.add(service.onDidRequestTool(call => {
			calls.push(call);
			if (!blockTools) { void service.completeTool({ id: call.id, result: commandFailure && call.name === 'run_terminal_command' ? { text: 'Exit code: 127\nzsh: command not found: vite', isError: true, exitCode: 127 } : { text: toolError ? 'Tool denied' : 'README contents', ...(toolError ? { isError: true } : {}) } }); }
		}));
	});

	teardown(async () => {
		await service?.abort();
		service?.dispose();
		server?.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});

	test('uses one Pi recovery follow-up after a failed command instead of stopping at a fallback promise', async () => {
		await service.initialize({ ...configuration, maxSteps: 4 });
		commandFailure = true;
		await service.prompt({ text: 'recover command failure', mode: 'build' });
		assert.deepStrictEqual({ calls: calls.map(call => call.name), requests: requests.length, last: snapshots.at(-1)?.turns.at(-1)?.content, hidden: snapshots.at(-1)?.turns.some(turn => turn.content.includes('IDE command recovery')) }, { calls: ['run_terminal_command', 'write_file'], requests: 4, last: 'Created the page.', hidden: false });
	});

	test('bounds command recovery to one follow-up when the model continues to promise work', async () => {
		await service.initialize({ ...configuration, maxSteps: 4 });
		commandFailure = true;
		await service.prompt({ text: 'recover command failure with stalled recovery', mode: 'build' });
		assert.deepStrictEqual({ calls: calls.map(call => call.name), requests: requests.length }, { calls: ['run_terminal_command'], requests: 3 });
	});

	test('does not start recovery when the failed command exhausted the tool budget', async () => {
		await service.initialize({ ...configuration, maxSteps: 1 });
		commandFailure = true;
		await service.prompt({ text: 'recover command failure', mode: 'build' });
		assert.deepStrictEqual({ calls: calls.map(call => call.name), requests: requests.length }, { calls: ['run_terminal_command'], requests: 2 });
	});

	test('never recovers automatically from a declined command without an exit code', async () => {
		await service.initialize({ ...configuration, maxSteps: 4 });
		toolError = true;
		await service.prompt({ text: 'recover command failure', mode: 'build' });
		assert.deepStrictEqual({ calls: calls.map(call => call.name), requests: requests.length }, { calls: ['run_terminal_command'], requests: 2 });
	});

	test('defaults new sessions to Agent while restoring the selected mode of existing sessions', async () => {
		const initial = await service.initialize(configuration);
		await service.prompt({ text: 'hello', mode: 'chat' });
		const created = await service.newSession();
		const restored = await service.openSession(initial.session.path);
		assert.deepStrictEqual([initial.mode, created.mode, restored.mode], ['build', 'build', 'chat']);
	});

	test('streams text with stable turn ids, keeps context hidden, and persists no credentials', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'hello', context: 'Private editor context', mode: 'chat' });
		const final = snapshots.at(-1)!;
		const pending = snapshots.find(snapshot => snapshot.turns.some(turn => turn.pending && turn.content === 'Hello'));
		assert.deepStrictEqual({ turns: final.turns.map(turn => [turn.role, turn.content]), streaming: final.isStreaming, sameId: pending?.turns.at(-1)?.id === final.turns.at(-1)?.id }, { turns: [['user', 'hello'], ['assistant', 'Hello from Pi']], streaming: false, sameId: true });
		const persisted = await readFile(final.session.path, 'utf8');
		assert(persisted.includes('Private editor context'));
		assert(!persisted.includes('in-memory-secret'));
		assert(!JSON.stringify(requests).includes('thinking'));
		assert(!await readdir(configuration.agentDir).then(names => names.includes('auth.json')));
	});

	test('lets Pi call the IDE tool and continue with its actual result', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'use tool', mode: 'chat' });
		assert.deepStrictEqual({ tools: calls.map(call => call.name), roles: snapshots.at(-1)!.turns.map(turn => turn.role), toolOutput: snapshots.at(-1)!.turns.find(turn => turn.role === 'tool')?.content, resultInContinuation: JSON.stringify(requests.at(-1)).includes('README contents') }, { tools: ['read_file'], roles: ['user', 'assistant', 'tool', 'assistant'], toolOutput: 'read_file\nREADME contents', resultInContinuation: true });
	});

	test('uses one Pi follow-up to recover a Build run that only announced work after inspection', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'prose after inspection', mode: 'build' });
		assert.deepStrictEqual({ calls: calls.map(call => call.name), requests: requests.length, content: snapshots.at(-1)!.turns.at(-1)?.content, streaming: snapshots.at(-1)!.isStreaming }, { calls: ['list_dir', 'write_file'], requests: 4, content: 'The page has been created.', streaming: false });
	});

	test('never continues a Chat inspection or a failed Build tool automatically', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'prose after inspection', mode: 'chat' });
		const chatRequests = requests.length;
		await service.newSession();
		requests = [];
		toolError = true;
		await service.prompt({ text: 'prose after inspection', mode: 'build' });
		assert.deepStrictEqual({ chatRequests, failedRequests: requests.length, writes: calls.filter(call => call.name === 'write_file').length }, { chatRequests: 2, failedRequests: 2, writes: 0 });
	});

	test('bounds the completion check even when the model keeps answering without changes', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'use tool', mode: 'build' });
		assert.deepStrictEqual({ calls: calls.map(call => call.name), requests: requests.length, streaming: snapshots.at(-1)!.isStreaming }, { calls: ['read_file'], requests: 3, streaming: false });
	});

	test('does not repeat a proposed modification whether it succeeds or is declined', async () => {
		await service.initialize(configuration);
		const results: { failed: boolean; requests: number; writes: number }[] = [];
		for (const failed of [false, true]) {
			await service.newSession();
			requests = [];
			calls = [];
			toolError = failed;
			await service.prompt({ text: 'mutation then prose', mode: 'build' });
			results.push({ failed, requests: requests.length, writes: calls.filter(call => call.name === 'write_file').length });
		}
		assert.deepStrictEqual(results, [{ failed: false, requests: 2, writes: 1 }, { failed: true, requests: 2, writes: 1 }]);
	});

	test('tells the model the active IDE mode on every turn without displaying internal instructions', async () => {
		await service.initialize(configuration);
		for (const mode of ['chat', 'build', 'plan'] as const) {
			await service.prompt({ text: 'hello', mode });
		}
		const modes = requests.map(request => [...JSON.stringify(request.messages).matchAll(/Current IDE mode: (chat|build|plan)\./g)].at(-1)?.[1]);
		assert.deepStrictEqual({ modes, visibleInternalState: snapshots.at(-1)!.turns.some(turn => turn.content.includes('Current IDE mode:')) }, { modes: ['chat', 'build', 'plan'], visibleInternalState: false });
	});

	test('keeps a usable output budget for small Ollama contexts and requests real token usage', async () => {
		await service.initialize({ ...configuration, endpoint: { ...configuration.endpoint, providerId: 'ollama', contextWindow: 4096, maxTokens: 2048 } });
		await service.prompt({ text: 'hello', mode: 'chat' });
		assert.deepStrictEqual({ usableBudget: (requests[0].max_tokens ?? 0) > 256, usage: requests[0].stream_options?.include_usage, streaming: snapshots.at(-1)?.isStreaming }, { usableBudget: true, usage: true, streaming: false });
	});

	test('caps Ollama generation to the loaded context rather than a larger client setting', async () => {
		await service.initialize({ ...configuration, endpoint: { ...configuration.endpoint, providerId: 'ollama', contextWindow: 8192, maxTokens: 4096 } });
		await service.prompt({ text: 'hello', mode: 'chat' });
		assert.deepStrictEqual({ usableBudget: (requests[0].max_tokens ?? 0) > 256, capped: requests[0].max_tokens! <= 2048 }, { usableBudget: true, capped: true });
	});

	test('falls back to the configured context when Ollama capacity discovery is unavailable', async () => {
		capacityAvailable = false;
		await service.initialize({ ...configuration, endpoint: { ...configuration.endpoint, providerId: 'ollama', contextWindow: 8192, maxTokens: 4096 } });
		await service.prompt({ text: 'hello', mode: 'chat' });
		assert.deepStrictEqual({ budget: requests[0].max_tokens, content: snapshots.at(-1)?.turns.at(-1)?.content }, { budget: 4096, content: 'Hello from Pi' });
	});

	test('disables Ollama default reasoning so the response budget produces an answer', async () => {
		await service.initialize({ ...configuration, endpoint: { ...configuration.endpoint, providerId: 'ollama' } });
		await service.prompt({ text: 'ollama greeting', mode: 'chat' });
		assert.deepStrictEqual({ content: snapshots.at(-1)!.turns.at(-1)?.content, streaming: snapshots.at(-1)!.isStreaming }, { content: 'Hello from Pi', streaming: false });
	});

	test('reports a completed reasoning-only response instead of an empty assistant turn', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'reasoning only', mode: 'chat' });
		const final = snapshots.at(-1)!;
		assert.deepStrictEqual({ streaming: final.isStreaming, hasError: !!final.turns.at(-1)?.error, reasoningVisible: JSON.stringify(final).includes('Internal reasoning') }, { streaming: false, hasError: true, reasoningVisible: false });
	});

	test('reports response truncation even when the model produced introductory text', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'truncated implementation', mode: 'build' });
		const final = snapshots.at(-1)!;
		assert.deepStrictEqual({ streaming: final.isStreaming, content: final.turns.at(-1)?.content, error: final.turns.at(-1)?.error, requests: requests.length }, { streaming: false, content: 'Next I will create CSS:', error: 'The model reached its response token limit before finishing. Ask it to continue with smaller edits, or increase the response token limit in AI settings.', requests: 1 });
	});

	test('preserves stream errors for the chat view and ends the busy state', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'broken stream', mode: 'chat' });
		assert.deepStrictEqual({ error: snapshots.at(-1)!.turns.at(-1)?.error, streaming: snapshots.at(-1)!.isStreaming }, { error: 'Stream ended without finish_reason', streaming: false });
	});

	test('advertises only mode tools and rejects a fabricated forbidden tool without bridge access', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'forbidden tool', mode: 'chat' });
		const names = requests[0].tools!.map(tool => tool.function.name).sort();
		assert.deepStrictEqual({ names, calls: calls.length }, { names: ['get_diagnostics', 'list_dir', 'read_file', 'search_code', 'search_memory', 'web_fetch', 'web_search'], calls: 0 });
	});

	test('handles and restores a structured plan without calling the IDE', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'plan tool', mode: 'plan' });
		const first = snapshots.at(-1)!;
		service.dispose();
		service = disposables.add(new PiAgentService());
		const restored = await service.initialize(configuration);
		assert.deepStrictEqual({ path: restored.session.path, plan: restored.plan, bridgeCalls: calls.length }, { path: first.session.path, plan: [{ id: 'first', title: 'Inspect project', status: 'in_progress' }], bridgeCalls: 0 });
	});

	test('stops repeated model tools at the configured invocation limit', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'repeat tool', mode: 'build' });
		assert.deepStrictEqual({ calls: calls.length, streaming: snapshots.at(-1)!.isStreaming, requests: requests.length }, { calls: 2, streaming: false, requests: 3 });
	});

	test('bounds fabricated tool attempts so forbidden calls cannot create an endless error loop', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'repeat forbidden tool', mode: 'chat' });
		assert.deepStrictEqual({ calls: calls.length, requests: requests.length }, { calls: 0, requests: 3 });
	});

	test('aborts a pending reverse call and isolates a new session from old snapshots', async () => {
		blockTools = true;
		await service.initialize(configuration);
		const running = service.prompt({ text: 'use tool', mode: 'build' });
		await new Promise<void>(resolve => {
			const listener = service.onDidRequestTool(() => { listener.dispose(); resolve(); });
		});
		const fresh = await service.newSession();
		await running;
		await service.completeTool({ id: calls[0].id, result: { text: 'late' } });
		assert.deepStrictEqual({ turns: fresh.turns, path: snapshots.at(-1)!.session.path, streaming: snapshots.at(-1)!.isStreaming }, { turns: [], path: fresh.session.path, streaming: false });
	});

	test('preserves history when model credentials change and rejects out-of-directory paths including symlinks', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'hello', mode: 'chat' });
		const current = snapshots.at(-1)!;
		const changed = await service.initialize({ ...configuration, endpoint: { ...configuration.endpoint, apiKey: 'new-secret' } });
		const outside = join(directory, 'outside.jsonl');
		await writeFile(outside, await readFile(current.session.path));
		const link = join(configuration.sessionDir, 'escape.jsonl');
		await symlink(outside, link);
		await assert.rejects(service.openSession(outside));
		await assert.rejects(service.openSession(link));
		assert.deepStrictEqual({ path: changed.session.path, turns: changed.turns.map(turn => turn.content) }, { path: current.session.path, turns: ['hello', 'Hello from Pi'] });
	});

	test('deletes only confined sessions and replaces the active session', async () => {
		await service.initialize(configuration);
		await service.prompt({ text: 'hello', mode: 'chat' });
		const previous = snapshots.at(-1)!.session.path;
		await assert.rejects(service.deleteSession(join(directory, 'outside.jsonl')));
		await service.deleteSession(previous);
		assert.deepStrictEqual({ sessions: await service.listSessions(), turns: snapshots.at(-1)!.turns, changed: snapshots.at(-1)!.session.path !== previous }, { sessions: [], turns: [], changed: true });
	});

	test('cancels a prompt before hidden context preparation can start a model request', async () => {
		await service.initialize(configuration);
		const running = service.prompt({ text: 'hello', context: 'editor context', mode: 'chat' });
		await service.abort();
		await running;
		assert.deepStrictEqual({ requests: requests.length, streaming: snapshots.at(-1)!.isStreaming }, { requests: 0, streaming: false });
	});

	test('ignores executable project and user extensions and persisted default native tools', async () => {
		const marker = join(directory, 'extension-ran');
		for (const base of [join(directory, '.pi'), configuration.agentDir]) {
			await mkdir(join(base, 'extensions'), { recursive: true });
			await writeFile(join(base, 'extensions', 'unsafe.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => {};`);
			await writeFile(join(base, 'settings.json'), JSON.stringify({ defaultTools: ['bash', 'edit', 'write'], extensions: ['./extensions/unsafe.ts'] }));
		}
		await service.initialize(configuration);
		await service.prompt({ text: 'hello', mode: 'build' });
		await assert.rejects(readFile(marker));
		assert.deepStrictEqual(requests[0].tools!.map(tool => tool.function.name).sort(), ['edit_file', 'get_diagnostics', 'list_dir', 'read_file', 'remember', 'run_terminal_command', 'search_code', 'search_memory', 'update_plan', 'web_fetch', 'web_search', 'write_file']);
	});

	test('uses Pi native compaction to persist a summary when history approaches the configured context window', async () => {
		await service.initialize({ ...configuration, endpoint: { ...configuration.endpoint, contextWindow: 4096, maxTokens: 512 } });
		// Pi compacts only across turn boundaries (a single oversized turn is split,
		// not summarized): build several moderate turns whose projected history crosses
		// the threshold so older turns remain to summarize.
		for (let index = 0; index < 12; index++) {
			await service.prompt({ text: `filler paragraph ${index} `.repeat(90), mode: 'chat' });
		}
		await service.prompt({ text: 'continue', mode: 'chat' });
		const persisted = await readFile(snapshots.at(-1)!.session.path, 'utf8');
		assert(persisted.includes('"type":"compaction"'));
	});
});
