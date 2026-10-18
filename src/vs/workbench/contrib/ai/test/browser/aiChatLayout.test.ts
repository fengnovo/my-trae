/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ChatViewId } from '../../../chat/browser/chat.js';
import { MYTRAE_VIEW_CONTAINER_ID, MyTraeChatLayoutContribution, ToggleVSCodeChatAction } from '../../browser/aiChatLayout.js';
import { AIChatViewPane } from '../../browser/aiChatView.js';

suite('MyTrae chat layout', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const services = workbenchInstantiationService(undefined, store);
		const storage = store.add(new InMemoryStorageService());
		services.stub(IStorageService, storage);
		const container = upcastPartial<ViewContainer>({ id: MYTRAE_VIEW_CONTAINER_ID });
		let location = ViewContainerLocation.Sidebar;
		let active = ChatViewId;
		const moves: ViewContainerLocation[] = [];
		const opens: { id: string; focus: boolean | undefined }[] = [];
		const closed: string[] = [];
		const widths: number[] = [];
		services.stub(IWorkbenchLayoutService, upcastPartial<IWorkbenchLayoutService>({
			getSize: () => ({ width: 480, height: 800 }),
			setSize: (part, size) => { assert.strictEqual(part, Parts.AUXILIARYBAR_PART); widths.push(size.width); },
		}));
		services.stub(IViewDescriptorService, upcastPartial<IViewDescriptorService>({
			getViewContainerById: id => id === MYTRAE_VIEW_CONTAINER_ID ? container : null,
			getViewContainerLocation: () => location,
			moveViewContainerToLocation: (_container, target) => { moves.push(target); location = target; },
		}));
		services.stub(IViewsService, upcastPartial<IViewsService>({
			isViewVisible: id => id === active,
			openView: async (id, focus) => { opens.push({ id, focus }); active = id; return null; },
			closeView: id => { closed.push(id); if (active === id) { active = ''; } },
		}));
		return { services, storage, moves, opens, closed, widths, getActive: () => active, setLocation: (value: ViewContainerLocation) => { location = value; } };
	}

	test('widens the agent by 50 percent once per profile and preserves subsequent resizing', async () => {
		const { services, storage, widths } = setup();
		await services.createInstance(MyTraeChatLayoutContribution).ready;
		await services.createInstance(MyTraeChatLayoutContribution).ready;
		assert.deepStrictEqual({ widths, profileApplied: storage.getBoolean('myTrae.ai.widerAgentLayoutApplied', StorageScope.PROFILE, false) }, { widths: [720], profileApplied: true });
	});

	test('migrates the old left container and defaults to MyTrae instead of built-in Chat', async () => {
		const { services, moves, opens, getActive } = setup();
		await services.createInstance(MyTraeChatLayoutContribution).ready;
		assert.deepStrictEqual({ moves, opens, active: getActive() }, { moves: [ViewContainerLocation.AuxiliaryBar], opens: [{ id: AIChatViewPane.ID, focus: false }], active: AIChatViewPane.ID });
	});

	test('also applies the requested right-side layout to an existing panel placement', async () => {
		const { services, moves, setLocation } = setup();
		setLocation(ViewContainerLocation.Panel);
		await services.createInstance(MyTraeChatLayoutContribution).ready;
		assert.deepStrictEqual(moves, [ViewContainerLocation.AuxiliaryBar]);
	});

	test('applies the location migration once and preserves later manual moves', async () => {
		const { services, moves, setLocation } = setup();
		await services.createInstance(MyTraeChatLayoutContribution).ready;
		setLocation(ViewContainerLocation.Panel);
		await services.createInstance(MyTraeChatLayoutContribution).ready;
		assert.deepStrictEqual(moves, [ViewContainerLocation.AuxiliaryBar]);
	});

	test('the title-bar action shows built-in Chat and returns to MyTrae when hiding it', async () => {
		const { services, closed, getActive } = setup();
		await services.createInstance(MyTraeChatLayoutContribution).ready;
		const action = new ToggleVSCodeChatAction();
		await services.invokeFunction(accessor => action.run(accessor));
		assert.strictEqual(getActive(), ChatViewId);
		await services.invokeFunction(accessor => action.run(accessor));
		assert.deepStrictEqual({ closed, active: getActive() }, { closed: [ChatViewId], active: AIChatViewPane.ID });
	});
});
