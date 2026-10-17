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
		const { createServer } = await import('http');
		server = createServer(async (request, response) => {
			let body = '';
			for await (const chunk of request) { body += chunk; }
			const input = JSON.parse(body) as ModelRequest;
			requests.push(input);
			const user = input.messages.filter(message => message.role === 'user').at(-1);
			const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
			const hasResult = input.messages.some(message => message.role === 'tool');
			if (text?.includes('tool') && (!hasResult || text.includes('repeat')) && requests.length < 6) {
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
			if (!blockTools) { void service.completeTool({ id: call.id, result: { text: 'README contents' } }); }
		}));
	});

	teardown(async () => {
		await service?.abort();
		service?.dispose();
		server?.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
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
		await service.prompt({ text: 'long context '.repeat(1800), mode: 'chat' });
		await service.prompt({ text: 'continue', mode: 'chat' });
		const persisted = await readFile(snapshots.at(-1)!.session.path, 'utf8');
		assert(persisted.includes('"type":"compaction"'));
	});
});
