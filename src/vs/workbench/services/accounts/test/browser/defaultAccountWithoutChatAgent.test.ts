/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DefaultAccountService } from '../../browser/defaultAccount.js';
import { TestProductService } from '../../../../test/common/workbenchTestServices.js';

suite('Default account without a chat agent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves account operations without waiting for a provider', async () => {
		const service = store.add(new DefaultAccountService({ ...TestProductService, defaultChatAgent: undefined }));
		const account = await service.getDefaultAccount();
		const refreshed = await service.refresh();
		const signedIn = await service.signIn();
		await service.signOut();
		assert.deepStrictEqual({ account, refreshed, signedIn, provider: service.getDefaultAccountAuthenticationProvider() }, {
			account: null,
			refreshed: null,
			signedIn: null,
			provider: { id: '', name: '', enterprise: false },
		});
	});
});
