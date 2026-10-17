/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	Action2,
	MenuId,
	registerAction2,
} from '../../../../platform/actions/common/actions.js';
import {
	IAICredentialsService,
	ILLMService,
} from '../../../../platform/ai/common/ai.js';
import { AIConfig } from '../../../../platform/ai/common/aiConfiguration.js';
import { LLMService } from '../../../../platform/ai/common/llmService.js';
import {
	BUILT_IN_PROVIDERS,
	DEFAULT_EMBEDDING_MODELS,
	DEFAULT_PROVIDER_ID,
} from '../../../../platform/ai/common/modelCatalog.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import {
	Extensions as ConfigurationExtensions,
	IConfigurationRegistry,
	ConfigurationScope,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import {
	InstantiationType,
	registerSingleton,
} from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IAIChatService } from '../common/aiChat.js';
import { AIChatViewPane } from './aiChatView.js';
// Importing these modules registers their singletons (chat and credentials services).
import './aiChatService.js';
import './aiCredentialsService.js';

const VIEW_CONTAINER_ID = 'workbench.view.myTrae';
const FOCUS_CHAT_COMMAND_ID = 'myTrae.ai.focus';
const NEW_SESSION_COMMAND_ID = 'myTrae.ai.newSession';
const SET_API_KEY_COMMAND_ID = 'myTrae.ai.setApiKey';

const myTraeIcon = registerIcon(
	'mytrae-view-icon',
	Codicon.sparkle,
	localize('myTraeViewIcon', "View icon of the MyTrae AI view container."),
);

// --- View container and view ---

const viewContainer = Registry.as<IViewContainersRegistry>(
	ViewContainerExtensions.ViewContainersRegistry,
).registerViewContainer(
	{
		id: VIEW_CONTAINER_ID,
		title: localize2('myTrae.container', "MyTrae AI"),
		icon: myTraeIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			VIEW_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]),
		storageId: VIEW_CONTAINER_ID,
		hideIfEmpty: false,
		order: 5,
	},
	ViewContainerLocation.Sidebar,
);

const viewDescriptor: IViewDescriptor = {
	id: AIChatViewPane.ID,
	name: localize2('myTrae.chatView', "Chat"),
	containerIcon: myTraeIcon,
	ctorDescriptor: new SyncDescriptor(AIChatViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: FOCUS_CHAT_COMMAND_ID,
		title: localize2('myTrae.focusChat', "Focus AI Chat"),
	},
};

Registry.as<IViewsRegistry>(
	ViewContainerExtensions.ViewsRegistry,
).registerViews([viewDescriptor], viewContainer);

// --- Commands ---

class NewAIChatSessionAction extends Action2 {
	constructor() {
		super({
			id: NEW_SESSION_COMMAND_ID,
			title: localize2('myTrae.ai.newSession', "New Chat Session"),
			icon: Codicon.add,
			f1: true,
			category: localize2('myTrae.category', "MyTrae AI"),
			menu: [
				{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', AIChatViewPane.ID),
					group: 'navigation',
					order: 1,
				},
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatService = accessor.get(IAIChatService);
		const viewsService = accessor.get(IViewsService);
		await chatService.createSession();
		await viewsService.openView(AIChatViewPane.ID, true);
	}
}

/**
 * Collects a provider API key. The provider list comes from the built-in catalogue plus
 * whatever base URL is configured, and the secret goes straight into the encrypted
 * credentials store - it is never written to settings.json.
 */
class SetApiKeyAction extends Action2 {
	constructor() {
		super({
			id: SET_API_KEY_COMMAND_ID,
			title: localize2('myTrae.ai.setApiKey', "MyTrae: Set Provider API Key"),
			f1: true,
			category: localize2('myTrae.category', "MyTrae AI"),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const credentialsService = accessor.get(IAICredentialsService);

		const provider = await quickInputService.pick(
			BUILT_IN_PROVIDERS.map((entry) => ({
				id: entry.id,
				label: entry.label,
				description: entry.local
					? localize('myTrae.ai.localProvider', "local, no key required")
					: entry.baseUrl,
			})),
			{
				placeHolder: localize(
					'myTrae.ai.pickProvider',
					"Select the provider to store a key for",
				),
			},
		);
		if (!provider) {
			return;
		}

		if (await credentialsService.getApiKey(provider.id)) {
			const overwrite = await quickInputService.pick(
				[
					{
						id: 'replace',
						label: localize('myTrae.ai.replaceKey', "Replace existing key"),
					},
					{
						id: 'delete',
						label: localize('myTrae.ai.deleteKey', "Delete stored key"),
					},
				],
				{
					placeHolder: localize(
						'myTrae.ai.keyExists',
						"A key is already stored for {0}",
						provider.label,
					),
				},
			);
			if (overwrite?.id === 'delete') {
				await credentialsService.deleteApiKey(provider.id);
				return;
			}
			if (overwrite?.id !== 'replace') {
				return;
			}
		}

		const key = await quickInputService.input({
			password: true,
			title: localize('myTrae.ai.keyTitle', "API key for {0}", provider.label),
			placeHolder: localize('myTrae.ai.keyPlaceholder', "Paste the API key"),
			prompt: localize(
				'myTrae.ai.keyPrompt',
				"Stored encrypted on this machine via the OS keychain.",
			),
			ignoreFocusLost: true,
		});
		if (!key) {
			return;
		}

		await credentialsService.storeApiKey(provider.id, key.trim());
	}
}

// ViewsService registers myTrae.ai.focus from openCommandActionDescriptor above.
registerAction2(NewAIChatSessionAction);
registerAction2(SetApiKeyAction);

// --- Settings ---

const providerIds = BUILT_IN_PROVIDERS.map((provider) => provider.id);
const catalogModelIds = [
	...new Set(
		BUILT_IN_PROVIDERS.flatMap((provider) =>
			provider.models.map((model) => model.id),
		),
	),
].sort();

Registry.as<IConfigurationRegistry>(
	ConfigurationExtensions.Configuration,
).registerConfiguration({
	id: 'myTrae',
	title: localize('myTrae.configurationTitle', "MyTrae AI"),
	order: 26,
	properties: {
		[AIConfig.Provider]: {
			type: 'string',
			enum: providerIds,
			default: DEFAULT_PROVIDER_ID,
			markdownDescription: localize(
				'myTrae.provider',
				"Provider preset used for chat, completion and agent requests. Sets the default base URL and model.",
			),
		},
		[AIConfig.BaseUrl]: {
			type: 'string',
			default: '',
			markdownDescription: localize(
				'myTrae.baseUrl',
				"Overrides the preset base URL. For OpenAI compatible endpoints include the version segment, e.g. `https://api.example.com/v1`.",
			),
		},
		[AIConfig.Model]: {
			type: 'string',
			enum: catalogModelIds,
			default: undefined,
			markdownDescription: localize(
				'myTrae.model',
				"Model used for chat. Any model id served by the endpoint can be typed here.",
			),
		},
		[AIConfig.CompletionModel]: {
			type: 'string',
			default: '',
			markdownDescription: localize(
				'myTrae.completionModel',
				"Model used for inline code completion. Leave empty to reuse the chat model. Prefer a small, fast model here.",
			),
		},
		[AIConfig.AgentModel]: {
			type: 'string',
			default: '',
			markdownDescription: localize(
				'myTrae.agentModel',
				"Model used by the agent. Leave empty to reuse the chat model. Prefer a tool-calling capable model.",
			),
		},
		[AIConfig.Temperature]: {
			type: 'number',
			default: 0.2,
			minimum: 0,
			maximum: 2,
			description: localize(
				'myTrae.temperature',
				"Sampling temperature for chat and agent requests.",
			),
		},
		[AIConfig.MaxTokens]: {
			type: 'number',
			default: 4096,
			minimum: 256,
			description: localize(
				'myTrae.maxTokens',
				"Maximum number of tokens generated per chat or agent response.",
			),
		},
		[AIConfig.EmbeddingProvider]: {
			type: 'string',
			enum: providerIds,
			default: '',
			markdownDescription: localize(
				'myTrae.embeddingProvider',
				"Provider used for codebase indexing embeddings. Leave empty to reuse the main provider.",
			),
		},
		[AIConfig.EmbeddingBaseUrl]: {
			type: 'string',
			default: '',
			markdownDescription: localize(
				'myTrae.embeddingBaseUrl',
				"Overrides the embedding base URL. Required when the main provider has no embeddings API (for example Anthropic).",
			),
		},
		[AIConfig.EmbeddingModel]: {
			type: 'string',
			enum: [...DEFAULT_EMBEDDING_MODELS],
			default: 'text-embedding-v3',
			description: localize(
				'myTrae.embeddingModel',
				"Embedding model used for codebase indexing.",
			),
		},
		[AIConfig.CompletionEnabled]: {
			type: 'boolean',
			default: true,
			description: localize(
				'myTrae.completionEnabled',
				"Enable AI inline code completion.",
			),
		},
		[AIConfig.CompletionDebounceMs]: {
			type: 'number',
			default: 300,
			minimum: 100,
			maximum: 2000,
			description: localize(
				'myTrae.completionDebounceMs',
				"Idle time in milliseconds after typing before a completion request is sent.",
			),
		},
		[AIConfig.CompletionMaxPrefixLines]: {
			type: 'number',
			default: 60,
			minimum: 10,
			maximum: 500,
			description: localize(
				'myTrae.completionMaxPrefixLines',
				"Maximum number of lines before the cursor sent as completion context.",
			),
		},
		[AIConfig.AgentAutoApproveReads]: {
			type: 'boolean',
			default: true,
			description: localize(
				'myTrae.agentAutoApproveReads',
				"Let the agent read files and search the workspace without asking. Writes and terminal commands always require confirmation.",
			),
		},
		[AIConfig.AgentSearchUrl]: {
			type: 'string',
			default: '',
			description: localize('myTrae.agentSearchUrl', "SearxNG search endpoint for the Pi web_search tool (JSON format). Leave empty to disable web search."),
		},
		[AIConfig.AgentContextWindow]: {
			type: 'number',
			default: 32768,
			minimum: 4096,
			maximum: 2000000,
			description: localize('myTrae.agentContextWindow', "Context window available to Pi. Match this to the context size configured by your model provider."),
		},
		[AIConfig.AgentMaxSteps]: {
			type: 'number',
			default: 25,
			minimum: 1,
			maximum: 200,
			description: localize(
				'myTrae.agentMaxSteps',
				"Maximum number of tool calls in a single agent run before it stops and asks how to proceed.",
			),
		},
		[AIConfig.IndexingEnabled]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.RESOURCE,
			description: localize(
				'myTrae.indexingEnabled',
				"Build and maintain a semantic index of the workspace for `@codebase` retrieval.",
			),
		},
	},
});

// --- Services ---

registerSingleton(ILLMService, LLMService, InstantiationType.Delayed);
