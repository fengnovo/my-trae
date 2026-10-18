/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getVisbileViewContextKey, IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ChatViewId } from '../../chat/browser/chat.js';
import { AIChatViewPane } from './aiChatView.js';

export const MYTRAE_VIEW_CONTAINER_ID = 'workbench.view.myTrae';

/** Apply the requested right-side layout once, then preserve subsequent manual moves. */
export class MyTraeChatLayoutContribution implements IWorkbenchContribution {
	static readonly ID = 'myTrae.ai.defaultChatLayout';
	readonly ready: Promise<void>;

	constructor(
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IViewsService private readonly views: IViewsService,
		@IStorageService private readonly storage: IStorageService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@ILogService log: ILogService,
	) {
		this.ready = this.restoreLayout().catch(error => log.error('[MyTrae] Failed to restore chat layout', error));
	}

	private async restoreLayout(): Promise<void> {
		const container = this.descriptors.getViewContainerById(MYTRAE_VIEW_CONTAINER_ID);
		if (!container) { return; }
		const migrationKey = 'myTrae.ai.rightChatLayoutMigrated';
		if (!this.storage.getBoolean(migrationKey, StorageScope.PROFILE, false)) {
			if (this.descriptors.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
				this.descriptors.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'mytrae.defaultChatLayout');
			}
			this.storage.store(migrationKey, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		await this.views.openView(AIChatViewPane.ID, false);
		const widthKey = 'myTrae.ai.widerAgentLayoutApplied';
		if (this.descriptors.getViewContainerLocation(container) === ViewContainerLocation.AuxiliaryBar && !this.storage.getBoolean(widthKey, StorageScope.PROFILE, false)) {
			const size = this.layout.getSize(Parts.AUXILIARYBAR_PART);
			if (size.width > 0) {
				this.layout.setSize(Parts.AUXILIARYBAR_PART, { width: Math.round(size.width * 1.5), height: size.height });
				this.storage.store(widthKey, true, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
		}
	}
}

export class ToggleVSCodeChatAction extends Action2 {
	constructor() {
		super({
			id: 'myTrae.ai.toggleVSCodeChat',
			title: localize2('myTrae.toggleVSCodeChat', "Toggle VS Code Chat"),
			icon: Codicon.commentDiscussion,
			f1: true,
			toggled: ContextKeyExpr.has(getVisbileViewContextKey(ChatViewId)),
			menu: { id: MenuId.LayoutControlMenu, group: 'navigation', order: 4, when: IsAuxiliaryWindowContext.negate() },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const views = accessor.get(IViewsService);
		if (views.isViewVisible(ChatViewId)) {
			views.closeView(ChatViewId);
			await views.openView(AIChatViewPane.ID, true);
		} else {
			await views.openView(ChatViewId, true);
		}
	}
}

registerAction2(ToggleVSCodeChatAction);
registerWorkbenchContribution2(MyTraeChatLayoutContribution.ID, MyTraeChatLayoutContribution, WorkbenchPhase.AfterRestored);
