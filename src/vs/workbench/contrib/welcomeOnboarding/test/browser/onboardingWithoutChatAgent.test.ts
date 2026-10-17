/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ColorThemeData } from '../../../../services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService } from '../../../../services/themes/common/workbenchThemeService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';

suite('Onboarding without a default chat agent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('leaves the workbench available without opening a sign-in overlay', () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IProductService, { defaultChatAgent: undefined });
		instantiationService.stub(IWorkbenchThemeService, { getColorTheme: () => ColorThemeData.createLoadedEmptyTheme('test', '') });
		const onboarding = store.add(instantiationService.createInstance(OnboardingVariationA));
		onboarding.show();
		assert.strictEqual(onboarding.isShowing, false);
	});
});
