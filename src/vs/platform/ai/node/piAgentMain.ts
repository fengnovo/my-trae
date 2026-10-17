/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../base/parts/sandbox/node/electronTypes.js';
import { piAgentChannel } from '../common/piAgent.js';
import { PiAgentService } from './piAgentService.js';

if (!isUtilityProcess(process)) { throw new Error('piAgentMain must run in a utility process'); }

const disposables = new DisposableStore();
const server = disposables.add(new UtilityProcessServer());
const service = disposables.add(new PiAgentService());
server.registerChannel(piAgentChannel, ProxyChannel.fromService(service, disposables));
process.once('exit', () => disposables.dispose());
