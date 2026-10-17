/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPiAgentService } from '../../../../platform/ai/common/piAgent.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAIChatService } from '../common/aiChat.js';
import { PiAgentService } from './piAgentService.js';
import { PiAIChatService } from '../browser/piAIChatService.js';

registerSingleton(IPiAgentService, PiAgentService, InstantiationType.Delayed);
registerSingleton(IAIChatService, PiAIChatService, InstantiationType.Delayed);
