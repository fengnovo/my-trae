/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel, ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPiAgentHost, IPiHostConfiguration, IPiSnapshot, IPiToolRequest } from '../../../../../platform/ai/common/piAgent.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IOnDidTerminateUtilityrocessWorkerProcess } from '../../../../../platform/utilityProcess/common/utilityProcessWorkerService.js';
import { IUtilityProcessWorker, IUtilityProcessWorkerWorkbenchService } from '../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { PiAgentTools } from '../../browser/piAgentTools.js';
import { PiAgentService } from '../../electron-browser/piAgentService.js';

suite('Pi desktop lifecycle', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const configuration: IPiHostConfiguration = { cwd: '/workspace', agentDir: '/pi/config', sessionDir: '/pi/sessions', maxSteps: 2, endpoint: { providerId: 'local', api: 'openai-completions', baseUrl: 'http://localhost/v1', apiKey: 'memory-key', model: 'model', contextWindow: 32768, maxTokens: 1024 } };
	const snapshot: IPiSnapshot = { session: { id: 'one', title: 'One', path: '/pi/sessions/one.jsonl', updatedAt: 1 }, mode: 'chat', isStreaming: false, turns: [], plan: [] };

	function fixture() {
		const calls: string[] = [];
		let abortGate: Promise<void> | undefined;
		const aborted = new DeferredPromise<void>();
		const changes = store.add(new Emitter<IPiSnapshot>());
		const requests = store.add(new Emitter<IPiToolRequest>());
		let active = snapshot;
		const host: IPiAgentHost = {
			onDidChange: changes.event, onDidRequestTool: requests.event,
			initialize: async input => { calls.push(`initialize:${input.endpoint.apiKey}`); changes.fire(active); return active; },
			prompt: async input => { calls.push(`prompt:${input.text}`); },
			abort: async () => { calls.push('abort'); void aborted.complete(); await abortGate; },
			newSession: async () => { calls.push('new'); active = { ...snapshot, session: { ...snapshot.session, id: 'two' } }; changes.fire(active); return active; },
			openSession: async () => { active = { ...snapshot, session: { ...snapshot.session, id: 'three', path: '/pi/sessions/three.jsonl' } }; changes.fire(active); return active; },
			deleteSession: async () => { active = { ...snapshot, session: { ...snapshot.session, id: 'four' } }; changes.fire(active); },
			listSessions: async () => [snapshot.session],
			completeTool: async () => {},
			fetchWeb: async () => 'web text',
		};
		const terminated = new DeferredPromise<IOnDidTerminateUtilityrocessWorkerProcess>();
		const channel = ProxyChannel.fromService(host, store.add(new DisposableStore()));
		const adapter: IChannel = { call: (command, args) => channel.call(undefined, command, args), listen: (event, args) => channel.listen(undefined, event, args) };
		const worker = upcastPartial<IUtilityProcessWorker>({
			client: upcastPartial<IUtilityProcessWorker['client']>({ getChannel: <T extends IChannel>() => adapter as T }),
			onDidTerminate: terminated.p,
			dispose: () => {},
		});
		return { calls, worker, terminated, aborted, setAbortGate: (gate: Promise<void>) => { abortGate = gate; } };
	}

	function proxy(workers: IUtilityProcessWorkerWorkbenchService, reset = () => {}) {
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stubInstance(PiAgentTools, { dispose: () => {}, reset, execute: async () => ({ text: 'done' }), rollback: async () => {} });
		return store.add(new PiAgentService(workers, instantiation, new NullLogService()));
	}

	test('Stop cancels a prompt waiting for a worker to start', async () => {
		const host = fixture();
		const starting = new DeferredPromise<IUtilityProcessWorker>();
		const created = new DeferredPromise<void>();
		const service = proxy(upcastPartial<IUtilityProcessWorkerWorkbenchService>({ createWorker: () => { void created.complete(); return starting.p; } }));
		const sending = service.prompt({ text: 'cancelled', mode: 'build' });
		await created.p;
		await service.abort();
		await starting.complete(host.worker);
		await sending;
		assert.deepStrictEqual(host.calls.filter(call => call.startsWith('prompt:')), []);
	});

	test('a prompt waits until a requested new session finishes aborting the old run', async () => {
		const host = fixture();
		const service = proxy(upcastPartial<IUtilityProcessWorkerWorkbenchService>({ createWorker: async () => host.worker }));
		await service.initialize(configuration);
		host.calls.length = 0;
		const gate = new DeferredPromise<void>();
		host.setAbortGate(gate.p);
		const switching = service.newSession();
		const sending = service.prompt({ text: 'for new session', mode: 'chat' });
		await host.aborted.p;
		await Promise.resolve();
		await gate.complete();
		await Promise.all([switching, sending]);
		assert.deepStrictEqual(host.calls.filter(call => call === 'new' || call.startsWith('prompt:')), ['new', 'prompt:for new session']);
	});

	test('a restarted worker receives cached memory credentials before the next prompt', async () => {
		const first = fixture();
		const second = fixture();
		let count = 0;
		const service = proxy(upcastPartial<IUtilityProcessWorkerWorkbenchService>({ createWorker: async () => ++count === 1 ? first.worker : second.worker }));
		await service.initialize(configuration);
		await first.terminated.complete({ reason: { code: 1 } });
		await service.prompt({ text: 'after restart', mode: 'chat' });
		assert.deepStrictEqual(second.calls, ['initialize:memory-key', 'prompt:after restart']);
	});

	test('clears IDE checkpoints when new, open or active deletion switches sessions', async () => {
		const host = fixture();
		let resets = 0;
		const service = proxy(upcastPartial<IUtilityProcessWorkerWorkbenchService>({ createWorker: async () => host.worker }), () => { resets++; });
		await service.initialize(configuration);
		resets = 0;
		await service.newSession();
		await service.openSession('/pi/sessions/three.jsonl');
		await service.deleteSession('/pi/sessions/three.jsonl');
		assert.strictEqual(resets, 3);
	});
});
