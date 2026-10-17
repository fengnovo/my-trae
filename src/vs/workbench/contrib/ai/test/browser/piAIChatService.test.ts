/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILLMService, LLMProviderKind } from '../../../../../platform/ai/common/ai.js';
import { IPiAgentService, IPiHostConfiguration, IPiSnapshot } from '../../../../../platform/ai/common/piAgent.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { TestEnvironmentService } from '../../../../test/browser/workbenchTestServices.js';
import { PiAIChatService } from '../../browser/piAIChatService.js';
import { AIChatContextKind } from '../../common/aiChat.js';

suite('Pi AI chat projection', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const snapshot: IPiSnapshot = { session: { id: 'session-1', path: '/sessions/session-1.jsonl', title: 'Restored', updatedAt: 1 }, turns: [{ id: 'turn-1', role: 'assistant', content: 'Previous answer' }], isStreaming: false, mode: 'chat', plan: [] };

	function setup(endpointReady?: Promise<void>) {
		const changes = store.add(new Emitter<IPiSnapshot>());
		const requests = store.add(new Emitter<never>());
		const configurations: IPiHostConfiguration[] = [];
		const prompts: { text: string; context?: string }[] = [];
		const host = upcastPartial<IPiAgentService>({
			onDidChange: changes.event,
			onDidRequestTool: requests.event,
			initialize: async configuration => { configurations.push(configuration); return snapshot; },
			listSessions: async () => [snapshot.session],
			prompt: async input => { prompts.push(input); },
			abort: async () => { },
		});
		const llm = upcastPartial<ILLMService>({
			onDidChangeConfiguration: store.add(new Emitter<void>()).event,
			resolveEndpoint: async () => { await endpointReady; return { kind: LLMProviderKind.OpenAICompatible, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ephemeral-key', model: 'qwen3.5:9b' }; },
			listModels: () => [],
		});
		const configuration = new TestConfigurationService({ myTrae: { provider: 'ollama' } });
		store.add(configuration.onDidChangeConfigurationEmitter);
		const service = store.add(new PiAIChatService(host, llm, configuration, new TestContextService(), TestEnvironmentService, upcastPartial<IFileService>({}), upcastPartial<IModelService>({ getModel: () => null }), new NullLogService()));
		return { service, changes, configurations, prompts, host };
	}

	test('restores the Pi transcript instead of creating a second history', async () => {
		const { service, configurations } = setup();
		await service.ready;
		assert.deepStrictEqual({ active: service.activeSession?.id, turns: service.activeSession?.turns.map(turn => turn.content), api: configurations[0].endpoint.api }, { active: 'session-1', turns: ['Previous answer'], api: 'openai-completions' });
	});

	test('sends attached selection context to Pi and keeps user text separate', async () => {
		const { service, prompts } = setup();
		await service.send('Explain the selected code', [{ kind: AIChatContextKind.Selection, label: 'sample.ts:1', uri: URI.file('/sample.ts'), text: 'const secretMarker = 42;' }]);
		assert.deepStrictEqual({ text: prompts[0].text, hasContext: prompts[0].context?.includes('const secretMarker = 42;'), streaming: service.isStreaming }, { text: 'Explain the selected code', hasContext: true, streaming: false });
	});

	test('projects tool results and plan state from authoritative snapshots', async () => {
		const { service, changes } = setup();
		await service.ready;
		changes.fire({ ...snapshot, turns: [{ id: 'tool-1', role: 'tool', content: 'read_file: src/main.ts' }], plan: [{ id: '1', title: 'Inspect code', status: 'completed' }] });
		assert.deepStrictEqual({ role: service.activeSession?.turns[0].role, plan: service.plan }, { role: 'tool', plan: [{ id: '1', title: 'Inspect code', status: 'completed' }] });
	});
	test('ignores a second send while initialization is pending', async () => {
		const gate = new DeferredPromise<void>();
		const { service, prompts } = setup(gate.p);
		const first = service.send('first', []);
		await service.send('second', []);
		await gate.complete();
		await first;
		assert.deepStrictEqual(prompts.map(prompt => prompt.text), ['first']);
	});

	test('cancel before initialization completes never starts a model request', async () => {
		const gate = new DeferredPromise<void>();
		const { service, prompts } = setup(gate.p);
		const sending = service.send('cancel me', []);
		service.cancel();
		await gate.complete();
		await sending;
		assert.deepStrictEqual({ prompts, streaming: service.isStreaming }, { prompts: [], streaming: false });
	});

	test('reserves the session transition before awaiting the host', async () => {
		const { service, host, prompts } = setup();
		await service.ready;
		const gate = new DeferredPromise<IPiSnapshot>();
		host.newSession = () => gate.p;
		const switching = service.createSession();
		await service.send('must not reach old session', []);
		await gate.complete({ ...snapshot, session: { ...snapshot.session, id: 'session-2' } });
		await switching;
		assert.deepStrictEqual({ prompts, active: service.activeSession?.id, streaming: service.isStreaming }, { prompts: [], active: 'session-2', streaming: false });
	});

});
