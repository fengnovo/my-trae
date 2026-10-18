/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { toAction } from '../../../../base/common/actions.js';
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
import { AIConfig, readAIConfiguration } from '../../../../platform/ai/common/aiConfiguration.js';
import { PiAgentMode } from '../../../../platform/ai/common/piAgent.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
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
import { MANAGE_TRUST_COMMAND_ID } from '../../workspace/common/workspace.js';
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
	private readonly buttonHovers = new Map<HTMLButtonElement, IManagedHover>();
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
	private modeSelect!: HTMLSelectElement;
	private sessionTitle!: HTMLElement;
	private historyButton!: HTMLButtonElement;
	private newSessionButton!: HTMLButtonElement;
	private moreButton!: HTMLButtonElement;
	private rollbackButton!: HTMLButtonElement;
	private modelButton!: HTMLButtonElement;
	private modelLabel!: HTMLElement;
	private accessLabel!: HTMLElement;
	private accessButton!: HTMLButtonElement;
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
		@IClipboardService private readonly clipboardService: IClipboardService,
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

		this._register(this.aiConfigurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AIConfig.AgentAccessMode) && this.root) { this.renderSession(this.chatService.activeSession); }
		}));
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

		this.messagesContainer = DOM.append(this.root, $('.mytrae-chat-messages'));
		this.messagesContainer.setAttribute('role', 'log');
		this.messagesContainer.setAttribute('aria-live', 'polite');
		this.planContainer = DOM.append(this.root, $('.mytrae-chat-plan'));

		const inputRow = DOM.append(this.root, $('.mytrae-chat-input-row.mytrae-chat-composer'));
		this.contextRow = DOM.append(inputRow, $('.mytrae-chat-context-row'));
		this.contextRow.style.display = 'none';
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
		const attachButton = this.iconButton(actions, Codicon.add, localize('myTrae.chat.addContext', "Add Context"));
		attachButton.setAttribute('aria-haspopup', 'menu');
		this._register(DOM.addDisposableListener(attachButton, 'click', () => {
			this.contextMenuService.showContextMenu({
				getAnchor: () => attachButton,
				getActions: () => [
					toAction({ id: 'mytrae.attachFile', label: localize('myTrae.chat.attachActiveFile', "Attach Active File"), run: () => this.attachActiveEditor(false) }),
					toAction({ id: 'mytrae.attachSelection', label: localize('myTrae.chat.attachSelection', "Attach Selection"), run: () => this.attachActiveEditor(true) }),
					toAction({ id: 'mytrae.attachCodebase', label: localize('myTrae.chat.pickCodebase', "Search this codebase"), run: () => this.addContext({ kind: AIChatContextKind.Codebase, label: 'codebase' }) }),
				],
			});
		}));

		const accessButton = this.accessButton = this.iconButton(actions, Codicon.shield, localize('myTrae.chat.toolAccess', "Tool Access"));
		accessButton.classList.add('mytrae-chat-control', 'mytrae-chat-access');
		accessButton.setAttribute('aria-haspopup', 'menu');
		this.accessLabel = DOM.append(accessButton, $('span.mytrae-chat-control-label'));
		this.appendIcon(accessButton, Codicon.chevronDown);
		this._register(DOM.addDisposableListener(accessButton, 'click', () => {
			this.contextMenuService.showContextMenu({
				getAnchor: () => accessButton,
				getActions: () => [
					toAction({ id: 'mytrae.accessReview', label: localize('myTrae.chat.accessReview', "提示人工审核"), checked: this.aiConfigurationService.getValue<string>(AIConfig.AgentAccessMode) !== 'fullAccess', run: () => this.aiConfigurationService.updateValue(AIConfig.AgentAccessMode, 'review', ConfigurationTarget.USER) }),
					toAction({ id: 'mytrae.accessFull', label: localize('myTrae.chat.accessFull', "完全访问"), checked: this.aiConfigurationService.getValue<string>(AIConfig.AgentAccessMode) === 'fullAccess', run: () => this.aiConfigurationService.updateValue(AIConfig.AgentAccessMode, 'fullAccess', ConfigurationTarget.USER) }),
					toAction({ id: MANAGE_TRUST_COMMAND_ID, label: localize('myTrae.chat.manageTrust', "Manage Workspace Trust..."), run: () => this.commandService.executeCommand(MANAGE_TRUST_COMMAND_ID) }),
				],
			});
		}));
		this.renderModeControl(actions);
		const modelActions = DOM.append(actions, $('.mytrae-chat-model-actions'));
		this.modelButton = this.iconButton(modelActions, undefined, localize('myTrae.chat.selectModel', "Select Model"));
		this.modelButton.classList.add('mytrae-chat-control', 'mytrae-chat-model');
		this.modelButton.setAttribute('aria-haspopup', 'dialog');
		this.modelLabel = DOM.append(this.modelButton, $('span.mytrae-chat-control-label'));
		this.appendIcon(this.modelButton, Codicon.chevronDown);
		this._register(DOM.addDisposableListener(this.modelButton, 'click', () => void this.pickModel()));

		this.sendButton = this.iconButton(modelActions, Codicon.arrowUp, localize('myTrae.chat.send', "Send"));
		this.sendButton.classList.add('mytrae-chat-send');
		this._register(
			DOM.addDisposableListener(this.sendButton, 'click', () =>
				this.onSendClicked(),
			),
		);

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
		this.sessionTitle = DOM.append(toolbar, $('.mytrae-chat-session-title'));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), this.sessionTitle, () => this.sessionTitle.textContent ?? ''));
		const actions = DOM.append(toolbar, $('.mytrae-chat-toolbar-actions'));
		this.newSessionButton = this.iconButton(actions, Codicon.commentAdd, localize('myTrae.chat.newSessionLabel', "New Conversation"));
		this._register(DOM.addDisposableListener(this.newSessionButton, 'click', () => {
			void this.runSessionAction(async () => { await this.chatService.createSession(); });
		}));
		this.historyButton = this.iconButton(actions, Codicon.history, localize('myTrae.chat.history', "Conversation History"));
		this.historyButton.setAttribute('aria-haspopup', 'dialog');
		this._register(DOM.addDisposableListener(this.historyButton, 'click', () => void this.pickSession()));
		this.rollbackButton = this.iconButton(actions, Codicon.discard, localize('myTrae.chat.rollback', "Roll Back Changes"));
		this.rollbackButton.hidden = !this.chatService.rollback;
		this._register(DOM.addDisposableListener(this.rollbackButton, 'click', () => {
			void this.runSessionAction(async () => this.chatService.rollback?.());
		}));
		this.moreButton = this.iconButton(actions, Codicon.ellipsis, localize('myTrae.chat.moreActions', "More Conversation Actions"));
		this.moreButton.setAttribute('aria-haspopup', 'menu');
		this._register(DOM.addDisposableListener(this.moreButton, 'click', () => {
			this.contextMenuService.showContextMenu({
				getAnchor: () => this.moreButton,
				getActions: () => [
					toAction({ id: 'mytrae.deleteConversation', label: localize('myTrae.chat.deleteSessionLabel', "Delete Conversation"), enabled: !!this.chatService.activeSession, run: () => this.runSessionAction(async () => { const session = this.chatService.activeSession; if (session) { await this.chatService.deleteSession(session.id); } }) }),
					toAction({ id: 'mytrae.openSettings', label: localize('myTrae.chat.openSettings', "Open Settings"), run: () => this.commandService.executeCommand('workbench.action.openSettings', 'myTrae') }),
				],
			});
		}));
	}

	private renderModeControl(container: HTMLElement): void {
		const control = DOM.append(container, $('.mytrae-chat-control.mytrae-chat-mode-control'));
		control.hidden = !this.chatService.setMode;
		this.appendIcon(control, Codicon.sparkle);
		this.modeSelect = DOM.append(control, $('select.mytrae-chat-mode'));
		this.modeSelect.setAttribute('aria-label', localize('myTrae.chat.mode', "Agent Mode"));
		const modes: readonly { value: PiAgentMode; label: string }[] = [
			{ value: 'chat', label: localize('myTrae.chat.modeChat', "Chat") },
			{ value: 'plan', label: localize('myTrae.chat.modePlan', "Plan") },
			{ value: 'build', label: localize('myTrae.chat.modeAgent', "Agent") },
		];
		for (const mode of modes) {
			const option = DOM.append(this.modeSelect, $<HTMLOptionElement>('option'));
			option.value = mode.value;
			option.textContent = mode.label;
		}
		this.appendIcon(control, Codicon.chevronDown);
		this._register(DOM.addDisposableListener(this.modeSelect, 'change', () => {
			const mode = this.modeSelect.value;
			if (mode === 'chat' || mode === 'plan' || mode === 'build') {
				this.chatService.setMode?.(mode);
				this.renderControls();
			}
		}));
	}

	private appendIcon(container: HTMLElement, icon: ThemeIcon): void {
		const element = DOM.append(container, $('span'));
		element.classList.add(...ThemeIcon.asClassName(icon).split(' '));
		element.setAttribute('aria-hidden', 'true');
	}

	private iconButton(container: HTMLElement, icon: ThemeIcon | undefined, label: string): HTMLButtonElement {
		const button = DOM.append(container, $<HTMLButtonElement>('button.mytrae-chat-action'));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		if (icon) { this.appendIcon(button, icon); }
		this.buttonHovers.set(button, this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, label)));
		return button;
	}

	private async pickSession(): Promise<void> {
		await this.runSessionAction(async () => {
			const selected = await this.quickInputService.pick(this.chatService.sessions.map(session => ({
				label: session.title || localize('myTrae.chat.untitled', "New Conversation"),
				description: session.id === this.chatService.activeSession?.id ? localize('myTrae.chat.currentSession', "Current") : undefined,
				sessionId: session.id,
			})), { placeHolder: localize('myTrae.chat.pickSession', "Search conversation history") });
			if (selected && !this.messageDisposables.isDisposed) { await this.chatService.setActiveSession(selected.sessionId); }
		});
	}

	private async pickModel(): Promise<void> {
		await this.runSessionAction(async () => {
			const configuration = readAIConfiguration(this.aiConfigurationService);
			const current = this.chatService.setMode ? configuration.agentModel || configuration.chatModel : configuration.chatModel;
			const models = this.llmService.listModels().filter(model => model.provider === configuration.providerId && model.id !== current);
			const items: (IQuickPickItem & { modelId?: string })[] = [
				{ label: current, description: localize('myTrae.chat.currentModel', "Current Model"), modelId: current },
				...models.map(model => ({ label: model.label, description: model.id, modelId: model.id })),
				{ label: localize('myTrae.chat.customModel', "Enter Model ID..."), description: configuration.providerId },
			];
			const selected = await this.quickInputService.pick(items, { placeHolder: localize('myTrae.chat.pickModel', "Select a model for this provider"), matchOnDescription: true });
			if (!selected || this.messageDisposables.isDisposed) { return; }
			const model = selected.modelId ?? await this.quickInputService.input({ prompt: localize('myTrae.chat.modelId', "Enter a model ID supported by your provider"), value: current });
			if (!model?.trim() || this.messageDisposables.isDisposed) { return; }
			await this.aiConfigurationService.updateValue(this.chatService.setMode ? AIConfig.AgentModel : AIConfig.Model, model.trim());
		});
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
		if (this.chatService.isStreaming && !turns.some(turn => turn.pending)) {
			this.renderPending(this.messagesContainer, false);
		}

		this.sessionTitle.textContent = session?.title || localize('myTrae.chat.untitled', "New Conversation");
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
		if (turn.role === AIChatRole.Assistant && !turn.content.trim() && !turn.pending && !turn.error) {
			return;
		}
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

		element.setAttribute('role', 'article');
		element.setAttribute('aria-label', isUser ? localize('myTrae.chat.userMessage', "Your Message") : localize('myTrae.chat.aiMessage', "AI Message"));
		const header = DOM.append(element, $('.mytrae-chat-turn-header'));
		const copyStatus = DOM.append(header, $('span.mytrae-chat-copy-status'));
		copyStatus.setAttribute('role', 'status');
		const copy = DOM.append(header, $<HTMLButtonElement>('button.mytrae-chat-action.mytrae-chat-copy'));
		copy.type = 'button';
		copy.disabled = turn.content.length === 0;
		const copyLabel = localize('myTrae.chat.copyMessage', "Copy Message");
		copy.setAttribute('aria-label', copyLabel);
		this.appendIcon(copy, Codicon.copy);
		this.messageDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), copy, copyLabel));
		this.messageDisposables.add(DOM.addDisposableListener(copy, 'click', async () => {
			copy.disabled = true;
			try {
				await this.clipboardService.writeText(turn.content);
				if (copy.isConnected) { copyStatus.textContent = localize('myTrae.chat.copied', "Copied"); }
			} catch {
				if (copy.isConnected) { copyStatus.textContent = localize('myTrae.chat.copyFailed', "Copy Failed. Try Again."); }
			} finally {
				copy.disabled = turn.content.length === 0;
			}
		}));

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
				this.renderPending(body, turn.content.length > 0);
			}
			if (turn.error) {
				element.classList.add('error');
				const error = DOM.append(body, $('.mytrae-chat-turn-error'));
				error.setAttribute('role', 'alert');
				error.textContent = turn.error;
			}
		}
	}

	private renderPending(container: HTMLElement, hasContent: boolean): void {
		const pending = DOM.append(container, $('.mytrae-chat-pending'));
		const icon = DOM.append(pending, $('span'));
		icon.classList.add(...ThemeIcon.asClassName(Codicon.loading).split(' '));
		icon.setAttribute('aria-hidden', 'true');
		const label = DOM.append(pending, $('span'));
		label.textContent = hasContent ? '' : localize('myTrae.chat.thinking', "Thinking...");
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
		const sendLabel = streaming
			? localize('myTrae.chat.stop', "Stop")
			: localize('myTrae.chat.send', "Send");
		this.sendButton.setAttribute('aria-label', sendLabel);
		this.buttonHovers.get(this.sendButton)?.update(sendLabel);
		DOM.clearNode(this.sendButton);
		this.appendIcon(this.sendButton, streaming ? Codicon.debugStop : Codicon.arrowUp);
		this.sendButton.classList.toggle('stop', streaming);
		this.sendButton.disabled = !streaming && (this.submitting || this.changingSession);
		this.modeSelect.value = this.chatService.mode ?? 'build';
		this.modeSelect.disabled = busy;
		this.historyButton.disabled = busy || this.chatService.sessions.length === 0;
		this.newSessionButton.disabled = busy;
		this.moreButton.disabled = busy;
		this.modelButton.disabled = busy;
		this.accessButton.disabled = busy;
		this.accessLabel.textContent = this.aiConfigurationService.getValue<string>(AIConfig.AgentAccessMode) === 'fullAccess' ? localize('myTrae.chat.accessFull', "完全访问") : localize('myTrae.chat.accessReview', "提示人工审核");
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
		this.modelLabel.textContent = model || localize('myTrae.chat.selectModel', "Select Model");

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

			const items: (IQuickPickItem & { resource?: URI; codebase?: boolean })[] = [{
				label: localize('myTrae.chat.pickCodebase', "Search this codebase"),
				description: localize('myTrae.chat.pickCodebaseHint', "@codebase — semantic retrieval from the workspace index"),
				codebase: true,
			}, ...result.results.map((match) => ({
				label: basename(match.resource),
				description: match.resource.path,
				resource: match.resource,
			}))];

			if (this.messageDisposables.isDisposed || this.inputArea.value !== value) {
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
			if (picked.codebase) {
				this.addContext({
					kind: AIChatContextKind.Codebase,
					label: 'codebase',
				});
				return;
			}
			const resource = picked.resource!;
			const openModel = this.codeEditorService.listCodeEditors()
				.map(editor => editor.getModel())
				.find(model => model?.uri.toString() === resource.toString());
			this.addContext({
				kind: AIChatContextKind.File,
				label: labelForResource(resource),
				uri: resource,
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
