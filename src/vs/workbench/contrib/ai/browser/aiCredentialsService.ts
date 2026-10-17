/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAICredentialsService } from '../../../../platform/ai/common/ai.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import {
	InstantiationType,
	registerSingleton,
} from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from '../../../../platform/storage/common/storage.js';

/**
 * Stores provider API keys encrypted with the platform encryption service, which is
 * backed by Electron `safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret on
 * Linux). Keys are deliberately kept out of settings.json so they cannot leak through
 * settings sync or a shared dotfiles repository.
 */
export class AICredentialsService
	extends Disposable
	implements IAICredentialsService
{
	declare readonly _serviceBrand: undefined;

	private static readonly STORAGE_PREFIX = 'mytrae.ai.apiKey.';

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IEncryptionService private readonly encryptionService: IEncryptionService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async getApiKey(providerId: string): Promise<string | undefined> {
		const encrypted = this.storageService.get(
			AICredentialsService.STORAGE_PREFIX + providerId,
			StorageScope.APPLICATION,
		);
		if (!encrypted) {
			return undefined;
		}
		try {
			return await this.encryptionService.decrypt(encrypted);
		} catch (error) {
			// Happens when the OS keychain entry disappeared or the machine changed.
			this.logService.error(
				`[ai] unable to decrypt the API key of '${providerId}'`,
				error,
			);
			this.storageService.remove(
				AICredentialsService.STORAGE_PREFIX + providerId,
				StorageScope.APPLICATION,
			);
			return undefined;
		}
	}

	async storeApiKey(providerId: string, value: string): Promise<void> {
		if (value.length === 0) {
			await this.deleteApiKey(providerId);
			return;
		}
		const encrypted = await this.encryptionService.encrypt(value);
		this.storageService.store(
			AICredentialsService.STORAGE_PREFIX + providerId,
			encrypted,
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
		this._onDidChange.fire(providerId);
	}

	async deleteApiKey(providerId: string): Promise<void> {
		this.storageService.remove(
			AICredentialsService.STORAGE_PREFIX + providerId,
			StorageScope.APPLICATION,
		);
		this._onDidChange.fire(providerId);
	}

	isEncryptionAvailable(): Promise<boolean> {
		return this.encryptionService.isEncryptionAvailable();
	}
}

registerSingleton(
	IAICredentialsService,
	AICredentialsService,
	InstantiationType.Delayed,
);
