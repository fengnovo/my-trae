/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { localize } from '../../../../nls.js';
import { ILLMService } from '../../../../platform/ai/common/ai.js';
import { readAIConfiguration } from '../../../../platform/ai/common/aiConfiguration.js';
import { PiAgentMode } from '../../../../platform/ai/common/piAgent.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import {
	IQuickInputService,
	IQuickPickItem,
} from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import {
	ISearchService,
	QueryType,
} from '../../../services/search/common/search.js';
import {
	AIChatContextKind,
	AIChatRole,
	IAIChatContextItem,
	IAIChatService,
	IAIChatSession,
	IAIChatTurn,
} from '../common/aiChat.js';
import './media/aiChat.css';

const $ = DOM.$;

/** Max files offered in the `@` picker; the list is fuzzy filtered anyway. */
const FILE_PICK_LIMIT = 50;

/**
 * Sidebar chat panel. Renders the conversation of the active session, streams assistant
 * output as it arrives and collects the context references that are attached to the next
 * message.
 */
export class AIChatViewPane extends ViewPane {
	static readonly ID = 'workbench.view.myTrae.chat';

	private readonly messageDisposables = this._register(new DisposableStore());
	private readonly contextDisposables = this._register(new DisposableStore());
	private readonly bannerDisposables = this._register(new DisposableStore());
	private readonly filePickerScheduler = this._register(new RunOnceScheduler(() => void this.pickFile(), 200));
	private readonly expandedTools = new Set<string>();
	private pickerOpen = false;
	private submitting = false;
	private changingSession = false;
	private interactionError: string | undefined;
	private renderedSessionId: string | undefined;

	private root!: HTMLElement;
	private banner!: HTMLElement;
	private contextRow!: HTMLElement;
	private messagesContainer!: HTMLElement;
	private inputArea!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private statusElement!: HTMLElement;
	private modeSelect!: HTMLSelectElement;
	private sessionSelect!: HTMLSelectElement;
	private newSessionButton!: HTMLButtonElement;
	private deleteSessionButton!: HTMLButtonElement;
	private rollbackButton!: HTMLButtonElement;
	private planContainer!: HTMLElement;

	/** Context attached to the message that is about to be sent. */
	private pendingContext: IAIChatContextItem[] = [];

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService
		private readonly aiConfigurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAIChatService private readonly chatService: IAIChatService,
		@ILLMService private readonly llmService: ILLMService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService
		private readonly workspaceContextService: IWorkspaceContextService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			aiConfigurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);

		this._register(
			this.chatService.onDidChange(() => this.renderSession(this.chatService.activeSession)),
		);
		this._register(
			this.llmService.onDidChangeConfiguration(() =>
				this.renderConfigurationState(),
			),
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('mytrae-chat-view');

		this.root = DOM.append(container, $('.mytrae-chat-root'));

		this.banner = DOM.append(this.root, $('.mytrae-chat-banner'));
		this.banner.style.display = 'none';
		this.banner.setAttribute('role', 'alert');

		this.renderToolbar();

		this.contextRow = DOM.append(this.root, $('.mytrae-chat-context-row'));
		this.contextRow.style.display = 'none';

		this.messagesContainer = DOM.append(this.root, $('.mytrae-chat-messages'));
		this.messagesContainer.setAttribute('role', 'log');
		this.messagesContainer.setAttribute('aria-live', 'polite');
		this.planContainer = DOM.append(this.root, $('.mytrae-chat-plan'));

		const inputRow = DOM.append(this.root, $('.mytrae-chat-input-row'));
		this.inputArea = DOM.append(inputRow, $('textarea.mytrae-chat-input'));
		this.inputArea.placeholder = localize(
			'myTrae.chat.placeholder',
			"Ask about this codebase. Type @ to attach a file.",
		);
		this.inputArea.setAttribute(
			'aria-label',
			localize('myTrae.chat.ariaLabel', "AI chat input"),
		);
		this.inputArea.rows = 3;

		const actions = DOM.append(inputRow, $('.mytrae-chat-actions'));
		const attachButton = DOM.append(actions, $('button.mytrae-chat-action'));
		attachButton.className = `mytrae-chat-action ${ThemeIcon.asClassName(Codicon.fileAdd)}`;
		attachButton.title = localize(
			'myTrae.chat.attachActiveFile',
			"Attach Active File",
		);
		attachButton.setAttribute('aria-label', attachButton.title);
		this._register(
			DOM.addDisposableListener(attachButton, 'click', () =>
				this.attachActiveEditor(false),
			),
		);
		const selectionButton = DOM.append(actions, $('button.mytrae-chat-action'));
		selectionButton.classList.add(...ThemeIcon.asClassName(Codicon.selection).split(' '));
		selectionButton.title = localize('myTrae.chat.attachSelection', "Attach Selection");
		selectionButton.setAttribute('aria-label', selectionButton.title);
		this._register(DOM.addDisposableListener(selectionButton, 'click', () => this.attachActiveEditor(true)));

		this.sendButton = DOM.append(actions, $('button.mytrae-chat-send'));
		this.sendButton.textContent = localize('myTrae.chat.send', "Send");
		this._register(
			DOM.addDisposableListener(this.sendButton, 'click', () =>
				this.onSendClicked(),
			),
		);

		this.statusElement = DOM.append(this.root, $('.mytrae-chat-status'));

		this._register(
			DOM.addDisposableListener(this.inputArea, 'keydown', (event) =>
				this.onInputKeyDown(event),
			),
		);
		this._register(
			DOM.addDisposableListener(this.inputArea, 'input', () =>
				this.onInputChange(),
			),
		);

		this.renderSession(this.chatService.activeSession);
		this.renderConfigurationState();
		const renderReadyState = () => {
			if (!this.messageDisposables.isDisposed) {
				this.renderSession(this.chatService.activeSession);
			}
		};
		void this.chatService.ready?.then(renderReadyState, renderReadyState);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
		this.root.style.width = `${width}px`;
	}

	override focus(): void {
		super.focus();
		this.inputArea.focus();
	}

	// --- Rendering ---

	private renderToolbar(): void {
		const toolbar = DOM.append(this.root, $('.mytrae-chat-toolbar'));
		toolbar.setAttribute('role', 'group');
		toolbar.setAttribute('aria-label', localize('myTrae.chat.controls', "Conversation Controls"));
		this.modeSelect = DOM.append(toolbar, $('select.mytrae-chat-mode'));
		this.modeSelect.setAttribute('aria-label', localize('myTrae.chat.mode', "Agent Mode"));
		const modes: readonly { value: PiAgentMode; label: string }[] = [
			{ value: 'chat', label: localize('myTrae.chat.modeChat', "Chat") },
			{ value: 'plan', label: localize('myTrae.chat.modePlan', "Plan") },
			{ value: 'build', label: localize('myTrae.chat.modeBuild', "Build") },
		];
		for (const mode of modes) {
			const option = DOM.append(this.modeSelect, $<HTMLOptionElement>('option'));
			option.value = mode.value;
			option.textContent = mode.label;
		}
		this.modeSelect.hidden = !this.chatService.setMode;
		this._register(DOM.addDisposableListener(this.modeSelect, 'change', () => {
			const mode = this.modeSelect.value;
			if (mode === 'chat' || mode === 'plan' || mode === 'build') {
				this.chatService.setMode?.(mode);
				this.renderControls();
			}
		}));

		this.sessionSelect = DOM.append(toolbar, $('select.mytrae-chat-session'));
		this.sessionSelect.setAttribute('aria-label', localize('myTrae.chat.session', "Conversation"));
		this._register(DOM.addDisposableListener(this.sessionSelect, 'change', () => {
			void this.runSessionAction(async () => this.chatService.setActiveSession(this.sessionSelect.value));
		}));
		this.newSessionButton = DOM.append(toolbar, $('button.mytrae-chat-action'));
		this.newSessionButton.textContent = localize('myTrae.chat.newSession', "New");
		this.newSessionButton.setAttribute('aria-label', localize('myTrae.chat.newSessionLabel', "New Conversation"));
		this._register(DOM.addDisposableListener(this.newSessionButton, 'click', () => {
			void this.runSessionAction(async () => { await this.chatService.createSession(); });
		}));
		this.deleteSessionButton = DOM.append(toolbar, $('button.mytrae-chat-action'));
		this.deleteSessionButton.textContent = localize('myTrae.chat.deleteSession', "Delete");
		this.deleteSessionButton.setAttribute('aria-label', localize('myTrae.chat.deleteSessionLabel', "Delete Conversation"));
		this._register(DOM.addDisposableListener(this.deleteSessionButton, 'click', () => {
			const session = this.chatService.activeSession;
			if (session) {
				void this.runSessionAction(async () => this.chatService.deleteSession(session.id));
			}
		}));
		this.rollbackButton = DOM.append(toolbar, $('button.mytrae-chat-action'));
		this.rollbackButton.textContent = localize('myTrae.chat.rollback', "Roll Back Changes");
		this.rollbackButton.hidden = !this.chatService.rollback;
		this._register(DOM.addDisposableListener(this.rollbackButton, 'click', () => {
			void this.runSessionAction(async () => this.chatService.rollback?.());
		}));
	}

	private renderSession(session: IAIChatSession | undefined): void {
		if (!this.messagesContainer) {
			return;
		}

		const followOutput = this.renderedSessionId !== session?.id || this.messagesContainer.scrollHeight - this.messagesContainer.scrollTop - this.messagesContainer.clientHeight < 40;
		this.renderedSessionId = session?.id;
		const scrollTop = this.messagesContainer.scrollTop;
		this.messageDisposables.clear();
		DOM.clearNode(this.messagesContainer);

		const turns = session?.turns ?? [];
		const toolIds = new Set(turns.filter(turn => turn.role === AIChatRole.Tool).map(turn => turn.id));
		for (const id of this.expandedTools) {
			if (!toolIds.has(id)) {
				this.expandedTools.delete(id);
			}
		}
		if (turns.length === 0) {
			const empty = DOM.append(this.messagesContainer, $('.mytrae-chat-empty'));
			empty.textContent = localize(
				'myTrae.chat.empty',
				"No messages yet. Ask a question, or attach a file with @ and ask about it.",
			);
		} else {
			for (const turn of turns) {
				if (turn.role !== AIChatRole.System) {
					this.renderTurn(turn, followOutput);
				}
			}
		}

		DOM.clearNode(this.sessionSelect);
		for (const candidate of this.chatService.sessions) {
			const option = DOM.append(this.sessionSelect, $<HTMLOptionElement>('option'));
			option.value = candidate.id;
			option.textContent = candidate.title || localize('myTrae.chat.untitled', "New Conversation");
			option.selected = candidate.id === session?.id;
		}
		this.renderPlan();
		this.renderContextChips();
		this.renderControls();
		this.renderConfigurationState();
		if (followOutput) {
			this.scrollToBottom();
		} else {
			this.messagesContainer.scrollTop = scrollTop;
		}
	}

	private renderPlan(): void {
		DOM.clearNode(this.planContainer);
		const plan = this.chatService.plan ?? [];
		this.planContainer.hidden = plan.length === 0;
		if (plan.length === 0) {
			return;
		}
		const heading = DOM.append(this.planContainer, $('.mytrae-chat-plan-heading'));
		heading.textContent = localize('myTrae.chat.plan', "Plan");
		const list = DOM.append(this.planContainer, $('ul'));
		for (const step of plan) {
			const row = DOM.append(list, $('li'));
			const state = step.status === 'completed'
				? localize('myTrae.chat.planCompleted', "Completed")
				: step.status === 'in_progress'
					? localize('myTrae.chat.planInProgress', "In progress")
					: localize('myTrae.chat.planPending', "Pending");
			if (step.status === 'in_progress') {
				row.setAttribute('aria-current', 'step');
			}
			const icon = DOM.append(row, $('span'));
			icon.classList.add(...ThemeIcon.asClassName(step.status === 'completed' ? Codicon.pass : step.status === 'in_progress' ? Codicon.loading : Codicon.circleOutline).split(' '));
			icon.setAttribute('aria-hidden', 'true');
			const label = DOM.append(row, $('span'));
			label.textContent = localize('myTrae.chat.planStep', "{0}: {1}", state, step.title);
		}
	}

	private renderTurn(turn: IAIChatTurn, followOutput: boolean): void {
		if (turn.role === AIChatRole.Tool) {
			const details = DOM.append(this.messagesContainer, $<HTMLDetailsElement>('details.mytrae-chat-tool'));
			details.open = this.expandedTools.has(turn.id);
			details.classList.toggle('error', !!turn.error);
			const summary = DOM.append(details, $('summary'));
			const firstLine = turn.content.split('\n', 1)[0];
			const status = turn.pending ? localize('myTrae.chat.toolRunning', "Running") : turn.error ? localize('myTrae.chat.toolFailed', "Failed") : localize('myTrae.chat.toolFinished', "Finished");
			summary.textContent = localize('myTrae.chat.toolStep', "{0} · {1}", firstLine.slice(0, 120) || localize('myTrae.chat.tool', "Tool"), status);
			const result = DOM.append(details, $('pre'));
			result.textContent = turn.content;
			this.messageDisposables.add(DOM.addDisposableListener(details, 'toggle', () => {
				if (details.open) {
					this.expandedTools.add(turn.id);
				} else {
					this.expandedTools.delete(turn.id);
				}
			}));
			return;
		}
		const isUser = turn.role === AIChatRole.User;
		const element = DOM.append(
			this.messagesContainer,
			$(isUser ? '.mytrae-chat-turn.user' : '.mytrae-chat-turn.assistant'),
		);

		const role = DOM.append(element, $('.mytrae-chat-role'));
		role.textContent = isUser
			? localize('myTrae.chat.roleUser', "You")
			: localize('myTrae.chat.roleAssistant', "MyTrae");

		const body = DOM.append(element, $('.mytrae-chat-turn-body'));
		if (isUser) {
			body.textContent = turn.content;
			if (turn.context && turn.context.length > 0) {
				const refs = DOM.append(body, $('.mytrae-chat-turn-refs'));
				refs.textContent = turn.context
					.map((item) => `@${item.label}`)
					.join('  ');
			}
		} else {
			const rendered = this.messageDisposables.add(this.markdownRendererService.render({
				value: turn.content,
				isTrusted: false,
				supportHtml: false,
			}, {
				fillInIncompleteTokens: !!turn.pending,
				asyncRenderCallback: () => {
					if (followOutput && body.isConnected) {
						this.scrollToBottom();
					}
				},
				sanitizerConfig: { remoteImageIsAllowed: () => false },
			}));
			DOM.append(body, rendered.element);
			if (turn.pending) {
				const pending = DOM.append(body, $('.mytrae-chat-pending'));
				pending.textContent =
					turn.content.length === 0
						? localize('myTrae.chat.thinking', "Thinking...")
						: '';
				pending.classList.add(
					...ThemeIcon.asClassName(Codicon.loading).split(' '),
				);
			}
			if (turn.error) {
				element.classList.add('error');
			}
		}
	}

	private renderContextChips(): void {
		this.contextDisposables.clear();
		DOM.clearNode(this.contextRow);
		this.contextRow.style.display =
			this.pendingContext.length === 0 ? 'none' : 'flex';

		for (const item of this.pendingContext) {
			const chip = DOM.append(this.contextRow, $('.mytrae-chat-chip'));
			const label = DOM.append(chip, $('.mytrae-chat-chip-label'));
			label.textContent = `@${item.label}`;
			chip.title = item.uri?.toString(true) ?? item.label;

			const remove = DOM.append(chip, $('button.mytrae-chat-chip-remove'));
			remove.className = `mytrae-chat-chip-remove ${ThemeIcon.asClassName(Codicon.close)}`;
			remove.setAttribute(
				'aria-label',
				localize('myTrae.chat.removeContext', "Remove context"),
			);
			this.contextDisposables.add(
				DOM.addDisposableListener(remove, 'click', () => {
					this.pendingContext = this.pendingContext.filter(
						(candidate) => candidate !== item,
					);
					this.renderContextChips();
				}),
			);
		}
	}

	private renderControls(): void {
		const streaming = this.chatService.isStreaming;
		const busy = streaming || this.submitting || this.changingSession;
		this.sendButton.textContent = streaming
			? localize('myTrae.chat.stop', "Stop")
			: localize('myTrae.chat.send', "Send");
		this.sendButton.classList.toggle('stop', streaming);
		this.sendButton.disabled = !streaming && (this.submitting || this.changingSession);
		this.modeSelect.value = this.chatService.mode ?? 'chat';
		this.modeSelect.disabled = busy;
		this.sessionSelect.disabled = busy || this.chatService.sessions.length === 0;
		this.newSessionButton.disabled = busy;
		this.deleteSessionButton.disabled = busy || !this.chatService.activeSession;
		this.rollbackButton.disabled = busy;
		this.messagesContainer.setAttribute('aria-busy', String(streaming));
	}

	private renderConfigurationState(): void {
		if (!this.banner) {
			return;
		}

		this.bannerDisposables.clear();
		DOM.clearNode(this.banner);
		const configured = this.llmService.isConfigured();
		const error = this.interactionError ?? this.chatService.initializationError;
		this.banner.style.display = configured && !error ? 'none' : 'flex';

		const configuration = readAIConfiguration(this.aiConfigurationService);
		const model = this.chatService.setMode ? configuration.agentModel || configuration.chatModel : configuration.chatModel;
		this.statusElement.textContent = configured
			? `${configuration.providerId} · ${model}`
			: localize('myTrae.chat.notConfiguredShort', "Provider not configured");

		if (!configured || error) {
			const text = DOM.append(this.banner, $('.mytrae-chat-banner-text'));
			text.textContent = error ?? localize(
				'myTrae.chat.notConfigured',
				"Set a provider API key to start chatting. Keys are stored encrypted on this machine.",
			);

			const setKey = DOM.append(
				this.banner,
				$('button.mytrae-chat-banner-action'),
			);
			setKey.textContent = localize('myTrae.chat.setApiKey', "Set API Key");
			this.bannerDisposables.add(
				DOM.addDisposableListener(setKey, 'click', () => {
					void this.commandService.executeCommand('myTrae.ai.setApiKey');
				}),
			);

			const openSettings = DOM.append(
				this.banner,
				$('button.mytrae-chat-banner-action.secondary'),
			);
			openSettings.textContent = localize(
				'myTrae.chat.openSettings',
				"Open Settings",
			);
			this.bannerDisposables.add(
				DOM.addDisposableListener(openSettings, 'click', () => {
					void this.commandService.executeCommand(
						'workbench.action.openSettings',
						'myTrae',
					);
				}),
			);
		}
	}

	private scrollToBottom(): void {
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	// --- Interaction ---

	private showInteractionError(error: Error | string): void {
		this.interactionError = toErrorMessage(error);
		this.renderConfigurationState();
	}

	private async runSessionAction(action: () => Promise<void>): Promise<void> {
		if (this.changingSession || this.submitting || this.chatService.isStreaming) {
			return;
		}
		this.changingSession = true;
		this.interactionError = undefined;
		this.filePickerScheduler.cancel();
		this.renderControls();
		try {
			await action();
		} catch (error) {
			this.showInteractionError(toErrorMessage(error));
		} finally {
			this.changingSession = false;
			if (!this.messageDisposables.isDisposed) {
				this.renderSession(this.chatService.activeSession);
			}
		}
	}

	private onInputKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void this.onSendClicked();
		}
	}

	/** Opens the file picker when the user types `@`, mirroring the reference syntax. */
	private onInputChange(): void {
		this.filePickerScheduler.schedule();
	}

	private async onSendClicked(): Promise<void> {
		if (this.chatService.isStreaming) {
			this.chatService.cancel();
			this.renderControls();
			return;
		}
		if (this.submitting || this.changingSession) {
			return;
		}

		const text = this.inputArea.value;
		if (text.trim().length === 0) {
			return;
		}

		this.inputArea.value = '';
		const context = this.pendingContext;
		this.pendingContext = [];
		this.submitting = true;
		this.interactionError = undefined;
		this.filePickerScheduler.cancel();
		this.renderContextChips();
		this.renderControls();
		this.renderConfigurationState();
		try {
			await this.chatService.send(text, context);
		} catch (error) {
			if (this.messageDisposables.isDisposed) {
				return;
			}
			// Preserve both the failed message and anything typed while it was sending.
			this.inputArea.value = this.inputArea.value ? `${text}\n\n${this.inputArea.value}` : text;
			for (const item of context) {
				this.addContext(item);
			}
			this.showInteractionError(toErrorMessage(error));
		} finally {
			this.submitting = false;
			if (!this.messageDisposables.isDisposed) {
				this.renderControls();
			}
		}
	}

	private async pickFile(): Promise<void> {
		if (this.pickerOpen || this.changingSession || this.submitting) {
			return;
		}
		const value = this.inputArea.value;
		const atIndex = value.lastIndexOf('@');
		const pattern = value.slice(atIndex + 1);
		if (atIndex === -1 || /\s/.test(pattern) || (atIndex > 0 && !/\s/.test(value[atIndex - 1]))) {
			return;
		}
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}

		this.pickerOpen = true;
		try {
			const result = await this.searchService.fileSearch({
				type: QueryType.File,
				folderQueries: folders.map((folder) => ({ folder: folder.uri })),
				filePattern: pattern,
				maxResults: FILE_PICK_LIMIT,
			});

			const items: (IQuickPickItem & { resource: URI })[] = result.results.map(
				(match) => ({
					label: basename(match.resource),
					description: match.resource.path,
					resource: match.resource,
				}),
			);

			if (items.length === 0 || this.messageDisposables.isDisposed || this.inputArea.value !== value) {
				return;
			}

			const picked = await this.quickInputService.pick(items, {
				placeHolder: localize(
					'myTrae.chat.pickFile',
					"Attach a file to the conversation",
				),
				matchOnDescription: true,
			});

			if (!picked || this.messageDisposables.isDisposed || this.inputArea.value !== value) {
				return;
			}

			// Remove the `@query` token from the input, the attachment is now a chip.
			this.inputArea.value =
				this.inputArea.value.slice(0, atIndex) +
				this.inputArea.value.slice(atIndex + 1 + pattern.length);
			const openModel = this.codeEditorService.listCodeEditors()
				.map(editor => editor.getModel())
				.find(model => model?.uri.toString() === picked.resource.toString());
			this.addContext({
				kind: AIChatContextKind.File,
				label: labelForResource(picked.resource),
				uri: picked.resource,
				text: openModel?.getValue(),
			});
		} catch (error) {
			if (!this.messageDisposables.isDisposed) {
				this.showInteractionError(toErrorMessage(error));
			}
		} finally {
			this.pickerOpen = false;
			if (!this.messageDisposables.isDisposed && this.inputArea.value !== value) {
				this.filePickerScheduler.schedule();
			}
		}
	}

	private attachActiveEditor(selectionOnly: boolean): void {
		const editor =
			this.codeEditorService.getFocusedCodeEditor() ??
			this.codeEditorService.getActiveCodeEditor();
		const model = editor?.getModel();
		if (!editor || !model) {
			return;
		}

		const selection = editor.getSelection();
		const hasSelection = selectionOnly && !!selection && !selection.isEmpty();
		if (selectionOnly && !hasSelection) {
			this.showInteractionError(localize('myTrae.chat.noSelection', "Select text in an editor before attaching a selection."));
			return;
		}
		this.addContext({
			kind: hasSelection ? AIChatContextKind.Selection : AIChatContextKind.File,
			label: hasSelection
				? `${labelForResource(model.uri)}:${selection!.startLineNumber}-${selection!.endLineNumber}`
				: labelForResource(model.uri),
			uri: model.uri,
			range: hasSelection
				? {
						startLineNumber: selection!.startLineNumber,
						startColumn: selection!.startColumn,
						endLineNumber: selection!.endLineNumber,
						endColumn: selection!.endColumn,
					}
				: undefined,
			text: hasSelection ? model.getValueInRange(selection!) : model.getValue(),
		});
	}

	private addContext(item: IAIChatContextItem): void {
		const exists = this.pendingContext.some(
			(candidate) =>
				candidate.uri?.toString() === item.uri?.toString() &&
				candidate.range?.startLineNumber === item.range?.startLineNumber &&
				candidate.range?.startColumn === item.range?.startColumn &&
				candidate.range?.endLineNumber === item.range?.endLineNumber &&
				candidate.range?.endColumn === item.range?.endColumn,
		);
		if (!exists) {
			this.pendingContext.push(item);
		}
		this.renderContextChips();
		this.inputArea.focus();
	}
}

function labelForResource(resource: URI): string {
	const path = resource.path;
	const segments = path.split('/');
	return segments.length > 1 ? segments.slice(-2).join('/') : path;
}
