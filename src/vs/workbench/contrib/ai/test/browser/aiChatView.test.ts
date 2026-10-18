/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { IAction } from '../../../../../base/common/actions.js';
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
import { ILLMService, LLMProviderKind } from '../../../../../platform/ai/common/ai.js';
import { AIConfig } from '../../../../../platform/ai/common/aiConfiguration.js';
import { PiAgentMode } from '../../../../../platform/ai/common/piAgent.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
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
		const copied: string[] = [];
		let clipboardFails = false;
		services.stub(IClipboardService, new class extends mock<IClipboardService>() {
			override async writeText(text: string): Promise<void> {
				if (clipboardFails) { throw new Error('Clipboard unavailable'); }
				copied.push(text);
			}
		}());
		let menuActions: readonly IAction[] = [];
		let pickLabel: string | undefined;
		const secondSession: IAIChatSession = { id: 'second', title: 'Older Conversation', createdAt: 0, turns: [] };
		let activeSession = session;
		const configuration = new class extends TestConfigurationService {
			override async updateValue(key: string, value: string): Promise<void> { await this.setUserConfiguration(key, value); }
		}({ [AIConfig.Provider]: 'ollama', [AIConfig.Model]: 'current-model' });
		services.stub(IConfigurationService, configuration);
		services.stub(IContextMenuService, new class extends mock<IContextMenuService>() {
			override showContextMenu(delegate: IContextMenuDelegate): void { menuActions = delegate.getActions(); }
		}());
		services.stub(IQuickInputService, new class extends mock<IQuickInputService>() {
			override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[]): Promise<T | undefined> {
				return (await picks).find((item): item is T => item.type !== 'separator' && item.label === pickLabel);
			}
		}());
		let sentContext: readonly IAIChatContextItem[] = [];
		let sendResult: Promise<void> = Promise.resolve();
		let cancelled = false;
		let rolledBack = false;
		const chat = new class extends mock<IAIChatService>() {
			override readonly onDidChange = changed.event;
			override readonly sessions = [session, secondSession];
			override get activeSession() { return activeSession; }
			override setActiveSession(id: string): void { activeSession = this.sessions.find(candidate => candidate.id === id)!; }
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
			override listModels() { return [{ id: 'next-model', label: 'Next Model', provider: 'ollama', contextWindow: 32768, supportsTools: true, supportsFim: false, kind: LLMProviderKind.OpenAICompatible }]; }
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
			container, chat, session, commands, configuration, copied,
			setClipboardFails: (value: boolean) => { clipboardFails = value; },
			getMenuActions: () => menuActions,
			setPickLabel: (label: string) => { pickLabel = label; },
			refresh: () => changed.fire(session),
			setSelection: (value: Selection) => { selection = value; },
			setSendResult: (value: Promise<void>) => { sendResult = value; },
			getSentContext: () => sentContext,
			isCancelled: () => cancelled,
			isRolledBack: () => rolledBack,
		};
	}

	test('copies user and AI message text with Markdown preserved and success feedback', async () => {
		const { container, session, refresh, copied } = setup();
		const content = ['My question\nSecond line', '**Answer**\n\n```js\nconsole.log("hello");\n```'];
		session.turns.push({ id: 'user', role: AIChatRole.User, content: content[0], createdAt: 0, context: [{ kind: AIChatContextKind.Codebase, label: 'codebase' }] }, { id: 'ai', role: AIChatRole.Assistant, content: content[1], createdAt: 0 }, { id: 'tool', role: AIChatRole.Tool, content: 'read_file\ncontents', createdAt: 0 });
		refresh();
		const buttons = [...container.querySelectorAll<HTMLButtonElement>('.mytrae-chat-copy')];
		assert.strictEqual(buttons.length, 2);
		for (const button of buttons) { button.click(); await timeout(0); }
		assert.deepStrictEqual({ copied, feedback: [...container.querySelectorAll('.mytrae-chat-copy-status')].map(element => element.textContent) }, { copied: content, feedback: ['Copied', 'Copied'] });
	});

	test('handles clipboard failure and lets the user retry after message refresh', async () => {
		const { container, session, refresh, copied, setClipboardFails } = setup();
		session.turns.push({ id: 'user', role: AIChatRole.User, content: 'Copy this', createdAt: 0 });
		refresh();
		setClipboardFails(true);
		container.querySelector<HTMLButtonElement>('.mytrae-chat-copy')!.click();
		await timeout(0);
		assert.strictEqual(container.querySelector('.mytrae-chat-copy-status')!.textContent, 'Copy Failed. Try Again.');
		setClipboardFails(false);
		refresh();
		container.querySelector<HTMLButtonElement>('.mytrae-chat-copy')!.click();
		await timeout(0);
		assert.deepStrictEqual(copied, ['Copy this']);
	});

	test('allows selecting both user and AI text and removes the provider footer', () => {
		const { container, session, refresh } = setup();
		session.turns.push({ id: 'user', role: AIChatRole.User, content: 'Select my question', createdAt: 0 }, { id: 'assistant', role: AIChatRole.Assistant, content: '**Select my answer**', createdAt: 0 });
		refresh();
		const bodies = [...container.querySelectorAll<HTMLElement>('.mytrae-chat-turn-body')];
		assert.deepStrictEqual({ selections: bodies.map(body => mainWindow.getComputedStyle(body).userSelect), footer: container.querySelector('.mytrae-chat-status') }, { selections: ['text', 'text'], footer: null });
	});

	test('uses compact unlabeled messages with narrow right-aligned user bubbles and no empty AI rows', () => {
		const { container, session, refresh } = setup();
		container.style.width = '600px';
		session.turns.push(
			{ id: 'user', role: AIChatRole.User, content: 'A short question', createdAt: 0 },
			{ id: 'empty', role: AIChatRole.Assistant, content: '', createdAt: 0 },
			{ id: 'tool', role: AIChatRole.Tool, content: 'read_file\nResult', createdAt: 0 },
			{ id: 'answer', role: AIChatRole.Assistant, content: 'A compact answer.', createdAt: 0 },
		);
		refresh();
		const user = container.querySelector<HTMLElement>('.mytrae-chat-turn.user')!;
		const answer = container.querySelector<HTMLElement>('.mytrae-chat-turn.assistant')!;
		const userBounds = user.getBoundingClientRect();
		const answerBounds = answer.getBoundingClientRect();
		const paragraph = answer.querySelector('p')!.getBoundingClientRect();
		assert.deepStrictEqual({
			labels: container.querySelectorAll('.mytrae-chat-role').length,
			aiRows: container.querySelectorAll('.mytrae-chat-turn.assistant').length,
			narrow: userBounds.width <= answerBounds.width * 0.8,
			rightAligned: Math.abs(userBounds.right - answerBounds.right) < 1,
			noHeaderGap: paragraph.top - answerBounds.top < 8,
			compact: parseFloat(mainWindow.getComputedStyle(answer).marginBottom) <= 8,
		}, { labels: 0, aiRows: 1, narrow: true, rightAligned: true, noHeaderGap: true, compact: true });
	});

	test('configuration actions survive message updates', () => {
		const { container, session, refresh, commands } = setup(false);
		session.turns.push({ id: 'assistant', role: AIChatRole.Assistant, content: 'Hello', pending: true, createdAt: 0 });
		refresh();
		container.querySelector<HTMLButtonElement>('.mytrae-chat-banner-action')!.click();
		container.querySelector<HTMLButtonElement>('.mytrae-chat-banner-action.secondary')!.click();
		assert.deepStrictEqual(commands, ['myTrae.ai.setApiKey', 'workbench.action.openSettings']);
	});

	test('keeps conversation actions compact and composer controls within a narrow sidebar', () => {
		const { container, session, refresh } = setup();
		container.style.width = '300px';
		session.title = 'Readable conversation title';
		refresh();
		const toolbar = container.querySelector<HTMLElement>('.mytrae-chat-toolbar')!.getBoundingClientRect();
		const composer = container.querySelector<HTMLElement>('.mytrae-chat-composer');
		assert(composer, 'The input and its controls should share a composer');
		const bounds = composer.getBoundingClientRect();
		const input = composer.querySelector('textarea')!.getBoundingClientRect();
		const mode = composer.querySelector('.mytrae-chat-mode')!.getBoundingClientRect();
		const actions = [...container.querySelectorAll<HTMLButtonElement>('.mytrae-chat-toolbar button')].map(button => button.getBoundingClientRect());
		const controls = [...composer.querySelectorAll('button, select')].map(control => control.getBoundingClientRect());
		assert.deepStrictEqual({
			actionsFit: actions.every(action => action.left >= toolbar.left && action.right <= toolbar.right),
			controlsBelowInput: mode.top >= input.bottom,
			controlsFit: controls.every(control => control.left >= bounds.left && control.right <= bounds.right),
		}, { actionsFit: true, controlsBelowInput: true, controlsFit: true });
	});

	test('opens session history and switches to the picked conversation', async () => {
		const { container, chat, setPickLabel } = setup();
		setPickLabel('Older Conversation');
		container.querySelector<HTMLButtonElement>('[aria-label="Conversation History"]')?.click();
		await timeout(0);
		assert.strictEqual(chat.activeSession.id, 'second');
	});

	test('selects an agent model from the composer and persists the actual model setting', async () => {
		const { container, configuration, setPickLabel } = setup();
		setPickLabel('Next Model');
		container.querySelector<HTMLButtonElement>('[aria-label="Select Model"]')?.click();
		await timeout(0);
		assert.deepStrictEqual({ setting: configuration.getValue(AIConfig.AgentModel), label: container.querySelector('.mytrae-chat-model')?.textContent?.includes('next-model') }, { setting: 'next-model', label: true });
	});

	test('disables access changes during a run to avoid interrupting the agent', () => {
		const { container, chat, refresh } = setup();
		chat.isStreaming = true;
		refresh();
		assert.strictEqual(container.querySelector<HTMLButtonElement>('[aria-label="Tool Access"]')!.disabled, true);
		chat.isStreaming = false;
		refresh();
		assert.strictEqual(container.querySelector<HTMLButtonElement>('[aria-label="Tool Access"]')!.disabled, false);
	});

	test('defaults to human review and allows selecting full access and returning to review', async () => {
		const { container, configuration, getMenuActions, refresh } = setup();
		const label = () => container.querySelector('.mytrae-chat-access')!.textContent!.includes('提示人工审核');
		assert.strictEqual(label(), true);
		container.querySelector<HTMLButtonElement>('[aria-label="Tool Access"]')!.click();
		await getMenuActions().find(action => action.label === '完全访问')!.run();
		refresh();
		assert.deepStrictEqual({ setting: configuration.getValue('myTrae.agent.accessMode'), label: container.querySelector('.mytrae-chat-access')!.textContent!.includes('完全访问') }, { setting: 'fullAccess', label: true });
		container.querySelector<HTMLButtonElement>('[aria-label="Tool Access"]')!.click();
		await getMenuActions().find(action => action.label === '提示人工审核')!.run();
		refresh();
		assert.deepStrictEqual({ setting: configuration.getValue('myTrae.agent.accessMode'), review: label(), agentOption: container.querySelector('option[value="build"]')!.textContent }, { setting: 'review', review: true, agentOption: 'Agent' });
	});

	test('exposes workspace trust and settings through the access and more menus', async () => {
		const { container, commands, getMenuActions } = setup();
		container.querySelector<HTMLButtonElement>('[aria-label="Tool Access"]')!.click();
		await getMenuActions().find(action => action.id === 'workbench.trust.manage')!.run();
		container.querySelector<HTMLButtonElement>('[aria-label="More Conversation Actions"]')!.click();
		await getMenuActions().find(action => action.id === 'mytrae.openSettings')!.run();
		assert.deepStrictEqual(commands, ['workbench.trust.manage', 'workbench.action.openSettings']);
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
		container.querySelector<HTMLButtonElement>('[aria-label="Roll Back Changes"]')!.click();
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
		const { container, setSelection, setSendResult, getSentContext, getMenuActions } = setup();
		const attach = container.querySelector<HTMLButtonElement>('[aria-label="Add Context"]')!;
		attach.click();
		await getMenuActions().find(action => action.id === 'mytrae.attachFile')!.run();
		setSelection(new Selection(1, 1, 1, 4));
		attach.click();
		await getMenuActions().find(action => action.id === 'mytrae.attachSelection')!.run();
		setSelection(new Selection(1, 5, 1, 8));
		attach.click();
		await getMenuActions().find(action => action.id === 'mytrae.attachSelection')!.run();
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

	test('keeps the waiting label stationary while only the loading icon rotates', () => {
		const { container, session, chat, refresh } = setup();
		chat.isStreaming = true;
		session.turns.push({ id: 'waiting', role: AIChatRole.Assistant, content: '', pending: true, createdAt: 0 });
		refresh();
		const pending = container.querySelector<HTMLElement>('.mytrae-chat-pending')!;
		assert.deepStrictEqual({
			label: pending.textContent,
			labelAnimation: mainWindow.getComputedStyle(pending).animationName,
			separateIcon: !!pending.querySelector('.codicon-loading'),
			iconHasLabel: !!pending.querySelector('.codicon-loading')?.textContent,
		}, { label: 'Thinking...', labelAnimation: 'none', separateIcon: true, iconHasLabel: false });
	});

	test('shows waiting feedback before the first model message and removes it when the request ends', () => {
		const { container, session, chat, refresh } = setup();
		session.turns.push({ id: 'question', role: AIChatRole.User, content: 'Hello', createdAt: 0 });
		chat.isStreaming = true;
		refresh();
		const waiting = container.querySelector('.mytrae-chat-pending')?.textContent;
		chat.isStreaming = false;
		refresh();
		assert.deepStrictEqual({ waiting, finished: !!container.querySelector('.mytrae-chat-pending') }, { waiting: 'Thinking...', finished: false });
	});

	test('shows provider errors on empty assistant responses and restores the send control', () => {
		const { container, session, refresh } = setup();
		session.turns.push({ id: 'failed', role: AIChatRole.Assistant, content: '', error: 'Stream ended without finish_reason', createdAt: 0 });
		refresh();
		assert.deepStrictEqual({
			error: container.querySelector('.mytrae-chat-turn.error [role="alert"]')?.textContent,
			waiting: !!container.querySelector('.mytrae-chat-pending'),
			sendDisabled: container.querySelector<HTMLButtonElement>('.mytrae-chat-send')!.disabled,
		}, { error: 'Stream ended without finish_reason', waiting: false, sendDisabled: false });
	});
});
