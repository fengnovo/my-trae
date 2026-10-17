/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { ILLMService } from '../../../../../platform/ai/common/ai.js';
import { PiAgentMode } from '../../../../../platform/ai/common/piAgent.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { AIChatViewPane } from '../../browser/aiChatView.js';
import { AIChatContextKind, AIChatRole, IAIChatContextItem, IAIChatService, IAIChatSession } from '../../common/aiChat.js';

class TestAIChatView extends AIChatViewPane {
	renderForTest(container: HTMLElement): void { this.renderBody(container); }
}

suite('MyTrae chat view', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(configured = true) {
		const services = workbenchInstantiationService(undefined, store);
		const changed = store.add(new Emitter<IAIChatSession>());
		const session: IAIChatSession = { id: 'first', title: 'First', createdAt: 0, turns: [] };
		const commands: string[] = [];
		let sentContext: readonly IAIChatContextItem[] = [];
		let sendResult: Promise<void> = Promise.resolve();
		let cancelled = false;
		let rolledBack = false;
		const chat = new class extends mock<IAIChatService>() {
			override readonly onDidChange = changed.event;
			override readonly sessions = [session];
			override readonly activeSession = session;
			override isStreaming = false;
			override mode: PiAgentMode = 'chat';
			override readonly plan = [{ id: 'step', title: 'Check diagnostics', status: 'in_progress' as const }];
			override setMode(mode: PiAgentMode): void { this.mode = mode; }
			override async rollback(): Promise<void> { rolledBack = true; }
			override async send(_text: string, context: readonly IAIChatContextItem[]): Promise<void> {
				sentContext = context;
				return sendResult;
			}
			override cancel(): void { cancelled = true; }
		}();
		services.stub(IAIChatService, chat);
		services.stub(ILLMService, new class extends mock<ILLMService>() {
			override readonly onDidChangeConfiguration = Event.None;
			override isConfigured(): boolean { return configured; }
		}());
		services.stub(IViewDescriptorService, new class extends mock<IViewDescriptorService>() {
			override readonly onDidChangeLocation = Event.None;
			override getViewLocationById(): ViewContainerLocation { return ViewContainerLocation.AuxiliaryBar; }
		}());
		services.stub(ICommandService, new class extends mock<ICommandService>() {
			override async executeCommand(commandId: string): Promise<undefined> { commands.push(commandId); return undefined; }
		}());
		services.stub(IOpenerService, new class extends mock<IOpenerService>() {
			override async open(): Promise<boolean> { return true; }
		}());
		services.stub(ISearchService, new class extends mock<ISearchService>() { }());
		const model = store.add(createTextModel('unsaved text', null, {}, URI.file('/workspace/example.ts')));
		let selection = new Selection(1, 1, 1, 1);
		const editor = new class extends mock<ICodeEditor>() {
			override getModel() { return model; }
			override getSelection() { return selection; }
		}();
		services.stub(ICodeEditorService, new class extends mock<ICodeEditorService>() {
			override getFocusedCodeEditor() { return null; }
			override getActiveCodeEditor() { return editor; }
			override listCodeEditors() { return [editor]; }
		}());
		const container = append(mainWindow.document.body, $('.pane-body'));
		store.add(toDisposable(() => container.remove()));
		const view = store.add(services.createInstance(TestAIChatView, { id: AIChatViewPane.ID, title: 'Chat' }));
		view.renderForTest(container);
		return {
			container, chat, session, commands,
			refresh: () => changed.fire(session),
			setSelection: (value: Selection) => { selection = value; },
			setSendResult: (value: Promise<void>) => { sendResult = value; },
			getSentContext: () => sentContext,
			isCancelled: () => cancelled,
			isRolledBack: () => rolledBack,
		};
	}

	test('configuration actions survive message updates', () => {
		const { container, session, refresh, commands } = setup(false);
		session.turns.push({ id: 'assistant', role: AIChatRole.Assistant, content: 'Hello', pending: true, createdAt: 0 });
		refresh();
		container.querySelector<HTMLButtonElement>('.mytrae-chat-banner-action')!.click();
		container.querySelector<HTMLButtonElement>('.mytrae-chat-banner-action.secondary')!.click();
		assert.deepStrictEqual(commands, ['myTrae.ai.setApiKey', 'workbench.action.openSettings']);
	});

	test('wraps toolbar actions before compressing the conversation selector in a narrow sidebar', () => {
		const { container, session, refresh } = setup();
		container.style.width = '300px';
		session.title = 'Readable conversation title';
		refresh();
		const toolbar = container.querySelector<HTMLElement>('.mytrae-chat-toolbar')!.getBoundingClientRect();
		const mode = container.querySelector<HTMLSelectElement>('.mytrae-chat-mode')!.getBoundingClientRect();
		const conversation = container.querySelector<HTMLSelectElement>('.mytrae-chat-session')!.getBoundingClientRect();
		const actions = [...container.querySelectorAll<HTMLButtonElement>('.mytrae-chat-toolbar button')].map(button => button.getBoundingClientRect());
		assert.deepStrictEqual({
			conversationReadable: conversation.width > mode.width * 2,
			actionsWrap: actions.some(action => action.top > mode.bottom),
			controlsFit: [mode, conversation, ...actions].every(control => control.left >= toolbar.left && control.right <= toolbar.right),
		}, { conversationReadable: true, actionsWrap: true, controlsFit: true });
	});

	test('renders plan and untrusted Markdown while hiding system content and collapsing tool results', () => {
		const { container, session, refresh, chat, isCancelled, isRolledBack } = setup();
		session.turns.push(
			{ id: 'system', role: AIChatRole.System, content: 'Private instructions', createdAt: 0 },
			{ id: 'tool', role: AIChatRole.Tool, content: 'read_file\n<script>unsafe</script>', createdAt: 0 },
			{ id: 'answer', role: AIChatRole.Assistant, content: '**Answer**', createdAt: 0 },
		);
		refresh();
		const mode = container.querySelector<HTMLSelectElement>('.mytrae-chat-mode')!;
		mode.value = 'plan';
		mode.dispatchEvent(new mainWindow.Event('change'));
		container.querySelectorAll<HTMLButtonElement>('.mytrae-chat-toolbar button')[2].click();
		chat.isStreaming = true;
		refresh();
		container.querySelector<HTMLButtonElement>('.mytrae-chat-send')!.click();
		assert.deepStrictEqual({
			mode: chat.mode,
			plan: container.querySelector('[aria-current="step"]')?.textContent,
			toolOpen: container.querySelector<HTMLDetailsElement>('details')?.open,
			toolText: container.querySelector('details pre')?.textContent,
			scripts: container.querySelectorAll('script').length,
			systemVisible: container.textContent?.includes('Private instructions'),
			markdown: container.querySelector('strong')?.textContent,
			modeDisabled: mode.disabled,
			cancelled: isCancelled(),
			rolledBack: isRolledBack(),
		}, {
			mode: 'plan', plan: 'In progress: Check diagnostics', toolOpen: false,
			toolText: 'read_file\n<script>unsafe</script>', scripts: 0, systemVisible: false,
			markdown: 'Answer', modeDisabled: true, cancelled: true, rolledBack: true,
		});
	});

	test('captures unsaved file and distinct selection columns and restores draft on send failure', async () => {
		const { container, setSelection, setSendResult, getSentContext } = setup();
		const buttons = container.querySelectorAll<HTMLButtonElement>('.mytrae-chat-actions .mytrae-chat-action');
		buttons[0].click();
		setSelection(new Selection(1, 1, 1, 4));
		buttons[1].click();
		setSelection(new Selection(1, 5, 1, 8));
		buttons[1].click();
		const pending = new DeferredPromise<void>();
		setSendResult(pending.p);
		const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
		input.value = 'Original question';
		container.querySelector<HTMLButtonElement>('.mytrae-chat-send')!.click();
		input.value = 'Next draft';
		await pending.error(new Error('Send failed'));
		await timeout(0);
		assert.deepStrictEqual({
			draft: input.value,
			context: getSentContext().map(item => ({ kind: item.kind, text: item.text, column: item.range?.startColumn })),
			restoredAttachments: container.querySelectorAll('.mytrae-chat-chip').length,
			error: container.querySelector('.mytrae-chat-banner-text')?.textContent,
		}, {
			draft: 'Original question\n\nNext draft',
			context: [
				{ kind: AIChatContextKind.File, text: 'unsaved text', column: undefined },
				{ kind: AIChatContextKind.Selection, text: 'uns', column: 1 },
				{ kind: AIChatContextKind.Selection, text: 'ved', column: 5 },
			],
			restoredAttachments: 3, error: 'Send failed',
		});
	});
});
