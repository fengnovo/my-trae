/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBulkEditOptions, IBulkEditService, ResourceEdit, ResourceFileEdit, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { WorkspaceEdit } from '../../../../../editor/common/languages.js';
import { CodeIndexState, ICodeIndexService } from '../../../../../platform/ai/common/codeIndex.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService, IConfirmationResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { FileType } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ICommandDetectionCapability, ITerminalCommand, TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { mock } from '../../../../test/common/workbenchTestServices.js';
import { BulkEditService } from '../../../bulkEdit/browser/bulkEditService.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { PiAgentTools } from '../../browser/piAgentTools.js';

suite('Pi IDE tools', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setupTools(onConfirm?: () => Promise<IConfirmationResult>, provider = new InMemoryFileSystemProvider(), networkFetch: (url: string, signal?: AbortSignal) => Promise<string> = async () => '') {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(provider)));
		const instantiation = workbenchInstantiationService({ fileService: () => fileService }, store);
		const configuration = new TestConfigurationService();
		instantiation.stub(IConfigurationService, configuration);
		const root = instantiation.invokeFunction(accessor => accessor.get(IWorkspaceContextService).getWorkspace().folders[0].uri);
		await fileService.createFolder(root);
		const resource = URI.joinPath(root, 'test.ts');
		await fileService.writeFile(resource, VSBuffer.fromString('original'));
		const fileModel = store.add(await instantiation.invokeFunction(accessor => accessor.get(ITextFileService).files.resolve(resource)));
		const modelService = instantiation.invokeFunction(accessor => accessor.get(IModelService));
		let applied = 0;
		const bulk = new class extends mock<IBulkEditService>() {
			override async apply(input: ResourceEdit[] | WorkspaceEdit, _options?: IBulkEditOptions) {
				applied++;
				const edits = Array.isArray(input) ? input : ResourceEdit.convert(input);
				for (const edit of edits) {
					if (edit instanceof ResourceTextEdit) {
						const model = modelService.getModel(edit.resource);
						assert.ok(model);
						model.pushEditOperations(null, [edit.textEdit], () => null);
					} else if (edit instanceof ResourceFileEdit && edit.newResource) {
						assert.strictEqual(await fileService.exists(edit.newResource), false);
						await fileService.writeFile(edit.newResource, await edit.options.contents!);
					} else if (edit instanceof ResourceFileEdit && edit.oldResource) {
						await fileService.del(edit.oldResource);
					}
				}
				return { isApplied: true, ariaSummary: '' };
			}
		};
		instantiation.stub(IBulkEditService, bulk);
		instantiation.stub(IDialogService, new class extends TestDialogService {
			override confirm(): Promise<IConfirmationResult> { return onConfirm ? onConfirm() : Promise.resolve({ confirmed: true }); }
		});
		instantiation.stub(ITerminalService, new class extends mock<ITerminalService>() { });
		instantiation.stub(ICodeIndexService, upcastPartial<ICodeIndexService>({
			status: async () => ({ state: CodeIndexState.Disabled, files: 0, chunks: 0 }),
			search: async () => [],
		}));
		const tools = store.add(instantiation.createInstance(PiAgentTools, networkFetch));
		return { tools, resource, networkFetch, fileService, modelService, fileModel, instantiation, configuration, applied: () => applied };
	}

	test('requires review by default and skips modification dialogs only with explicit full access', async () => {
		let confirmations = 0;
		const fixture = await setupTools(async () => { confirmations++; return { confirmed: false }; });
		const request = { id: 'write', name: 'write_file' as const, mode: 'build' as const, arguments: { path: 'new.ts', content: 'agent edit' } };
		const reviewed = await fixture.tools.execute(request);
		await fixture.configuration.setUserConfiguration('myTrae.agent.accessMode', 'fullAccess');
		const allowed = await fixture.tools.execute(request);
		const memory = await fixture.tools.execute({ id: 'memory', name: 'remember', mode: 'build', arguments: { content: 'Project guidance' } });
		await fixture.configuration.setUserConfiguration('myTrae.agent.accessMode', 'review');
		const reviewedAgain = await fixture.tools.execute({ ...request, arguments: { path: 'other.ts', content: 'reviewed' } });
		assert.deepStrictEqual({ confirmations, declined: reviewed.isError, allowed: allowed.isError, memory: memory.isError, declinedAgain: reviewedAgain.isError, applied: fixture.applied() }, { confirmations: 2, declined: true, allowed: undefined, memory: undefined, declinedAgain: true, applied: 1 });
		fixture.tools.dispose();
		await timeout(0); // Allow the synthetic memory document reference to be released.
	});

	test('reads the unsaved editor rather than disk', async () => {
		const fixture = await setupTools();
		const model = store.add(await fixture.instantiation.invokeFunction(accessor => accessor.get(ITextModelService).createModelReference(fixture.resource)));
		model.object.textEditorModel.setValue('unsaved editor text');
		const result = await fixture.tools.execute({ id: 'read', name: 'read_file', mode: 'plan', arguments: { path: 'test.ts' } });
		assert.deepStrictEqual(result, { text: '1: unsaved editor text' });
	});

	test('reports an empty directory explicitly so the model can continue after inspection', async () => {
		const fixture = await setupTools();
		await fixture.fileService.createFolder(URI.joinPath(fixture.resource, '..', 'empty'));
		const result = await fixture.tools.execute({ id: 'list-empty', name: 'list_dir', mode: 'build', arguments: { path: 'empty' } });
		assert.deepStrictEqual({ isError: !!result.isError, hasResult: result.text.trim().length > 0 }, { isError: false, hasResult: true });
	});

	test('rejects model changes while approval is open', async () => {
		const fixture = await setupTools(async () => {
			fixture.modelService.getModel(fixture.resource)!.setValue('user edit');
			return { confirmed: true };
		});
		const result = await fixture.tools.execute({ id: 'edit', name: 'edit_file', mode: 'build', arguments: { path: 'test.ts', oldText: 'original', newText: 'agent edit' } });
		assert.deepStrictEqual({ error: result.isError, applied: fixture.applied(), disk: (await fixture.fileService.readFile(fixture.resource)).value.toString() }, { error: true, applied: 0, disk: 'original' });
		await fixture.fileModel.revert({ soft: true });
	});

	test('late approval after cancellation cannot write', async () => {
		const controller = new AbortController();
		const fixture = await setupTools(async () => { controller.abort(); return { confirmed: true }; });
		const result = await fixture.tools.execute({ id: 'write', name: 'write_file', mode: 'build', arguments: { path: 'new.ts', content: 'agent edit' } }, controller.signal);
		assert.deepStrictEqual({ error: result.isError, applied: fixture.applied(), exists: await fixture.fileService.exists(URI.joinPath(fixture.resource, '..', 'new.ts')) }, { error: true, applied: 0, exists: false });
	});

	test('plan mode cannot create a file and missing search configuration is explicit', async () => {
		const fixture = await setupTools();
		await fixture.configuration.setUserConfiguration('myTrae.agent.accessMode', 'fullAccess');
		const write = await fixture.tools.execute({ id: 'write', name: 'write_file', mode: 'plan', arguments: { path: 'new.ts', content: 'agent edit' } });
		const search = await fixture.tools.execute({ id: 'search', name: 'web_search', mode: 'plan', arguments: { query: 'test' } });
		assert.deepStrictEqual({ blocked: write.isError, applied: fixture.applied(), missingSearch: search.isError }, { blocked: true, applied: 0, missingSearch: true });
		assert.match(search.text, /myTrae.agent.searchUrl/);
	});

	test('rollback refuses later user edits', async () => {
		const fixture = await setupTools();
		const reference = store.add(await fixture.instantiation.invokeFunction(accessor => accessor.get(ITextModelService).createModelReference(fixture.resource)));
		const result = await fixture.tools.execute({ id: 'edit', name: 'edit_file', mode: 'build', arguments: { path: 'test.ts', oldText: 'original', newText: 'agent edit' } });
		assert.strictEqual(result.isError, undefined);
		reference.object.textEditorModel.setValue('later user edit');
		await assert.rejects(() => fixture.tools.rollback(), /subsequent edits/);
		assert.strictEqual(reference.object.textEditorModel.getValue(), 'later user edit');
		await fixture.fileModel.revert({ soft: true });
	});
	test('rejects a symlink ancestor before reading a file', async () => {
		const provider = new class extends InMemoryFileSystemProvider {
			override async stat(resource: URI) {
				const stat = await super.stat(resource);
				return { ...stat, type: resource.path.endsWith('/link') ? stat.type | FileType.SymbolicLink : stat.type };
			}
		};
		const fixture = await setupTools(undefined, provider);
		const link = URI.joinPath(fixture.resource, '..', 'link');
		await fixture.fileService.createFolder(link);
		await fixture.fileService.writeFile(URI.joinPath(link, 'secret'), VSBuffer.fromString('outside data'));
		const result = await fixture.tools.execute({ id: 'read', name: 'read_file', mode: 'build', arguments: { path: 'link/secret' } });
		assert.strictEqual(result.isError, true);
		assert.match(result.text, /symbolic links/);
	});

	test('new file creation and rollback use undoable bulk edits', async () => {
		const fixture = await setupTools();
		const created = URI.joinPath(fixture.resource, '..', 'new.ts');
		const result = await fixture.tools.execute({ id: 'write', name: 'write_file', mode: 'build', arguments: { path: 'new.ts', content: 'new content' } });
		assert.strictEqual(result.isError, undefined);
		assert.strictEqual((await fixture.fileService.readFile(created)).value.toString(), 'new content');
		await fixture.tools.rollback();
		assert.deepStrictEqual({ exists: await fixture.fileService.exists(created), applied: fixture.applied() }, { exists: false, applied: 2 });
	});

	test('rollback supports a saved agent edit but preserves external disk edits', async () => {
		const fixture = await setupTools();
		const result = await fixture.tools.execute({ id: 'edit', name: 'edit_file', mode: 'build', arguments: { path: 'test.ts', oldText: 'original', newText: 'agent edit' } });
		assert.strictEqual(result.isError, undefined);
		await fixture.fileService.writeFile(fixture.resource, VSBuffer.fromString('external user edit'));
		await assert.rejects(() => fixture.tools.rollback(), /subsequent edits/);
		assert.strictEqual((await fixture.fileService.readFile(fixture.resource)).value.toString(), 'external user edit');
		await fixture.fileService.writeFile(fixture.resource, VSBuffer.fromString('agent edit'));
		await fixture.tools.rollback();
		assert.strictEqual(fixture.fileModel.textEditorModel!.getValue(), 'original');
		await fixture.fileModel.revert({ soft: true });
	});

	test('project memory is searchable and persists across tool instances', async () => {
		const fixture = await setupTools();
		const remembered = await fixture.tools.execute({ id: 'memory', name: 'remember', mode: 'build', arguments: { content: 'Use tabs for indentation' } });
		assert.strictEqual(remembered.isError, undefined);
		const memory = fixture.instantiation.invokeFunction(accessor => accessor.get(ITextFileService).files.models.find(model => model.resource.scheme.startsWith('pi-memory-')));
		assert.ok(memory, 'Memory must resolve to an editable file model');
		assert.strictEqual(memory.isReadonly(), false);
		memory.textEditorModel!.setValue('Use tabs for indentation; edited by user');
		await memory.save();
		fixture.tools.dispose();
		const restored = store.add(fixture.instantiation.createInstance(PiAgentTools, fixture.networkFetch));
		const result = await restored.execute({ id: 'search', name: 'search_memory', mode: 'plan', arguments: { query: 'tabs' } });
		assert.deepStrictEqual(result, { text: 'Use tabs for indentation; edited by user' });
		restored.dispose();
		await timeout(0); // Synthetic document reference release completes asynchronously.
	});

	test('full access runs terminal commands without a dialog and returns correlated output and exit status', async () => {
		const fixture = await setupTools(async () => assert.fail('Full access must not ask for approval'));
		await fixture.configuration.setUserConfiguration('myTrae.agent.accessMode', 'fullAccess');
		const finished = store.add(new Emitter<ITerminalCommand>());
		let exitCode = 0;
		const capabilities = store.add(new TerminalCapabilityStore());
		capabilities.add(TerminalCapability.CommandDetection, new class extends mock<ICommandDetectionCapability>() {
			override readonly onCommandFinished = finished.event;
			override readonly hasRichCommandDetection = true;
		});
		const terminal = new class extends mock<ITerminalInstance>() {
			override readonly capabilities = capabilities;
			override readonly onExit = Event.None;
			override async runCommand(_command: string, _execute: boolean, commandId?: string) {
				finished.fire(new class extends mock<ITerminalCommand>() {
					override id = commandId;
					override exitCode = exitCode;
					override getOutput() { return 'actual command output'; }
				});
			}
		};
		fixture.instantiation.stub(ITerminalService, new class extends mock<ITerminalService>() {
			override async createTerminal() { return terminal; }
			override async revealTerminal() { }
		});
		const tools = store.add(fixture.instantiation.createInstance(PiAgentTools, fixture.networkFetch));
		const results = [];
		for (exitCode of [0, 7, 127]) {
			results.push(await tools.execute({ id: 'command', name: 'run_terminal_command', mode: 'build', arguments: { command: 'echo hello' } }));
		}
		assert.deepStrictEqual(results, [{ text: 'Exit code: 0\nactual command output', exitCode: 0 }, { text: 'Exit code: 7\nactual command output', isError: true, exitCode: 7 }, { text: 'Exit code: 127\nactual command output', isError: true, exitCode: 127 }]);
	});

	test('late terminal approval after abort never creates or starts a terminal', async () => {
		const controller = new AbortController();
		const fixture = await setupTools(async () => { controller.abort(); return { confirmed: true }; });
		let created = 0;
		fixture.instantiation.stub(ITerminalService, new class extends mock<ITerminalService>() {
			override async createTerminal(): Promise<ITerminalInstance> { created++; throw new Error('Unexpected terminal'); }
		});
		const tools = store.add(fixture.instantiation.createInstance(PiAgentTools, fixture.networkFetch));
		const result = await tools.execute({ id: 'command', name: 'run_terminal_command', mode: 'build', arguments: { command: 'echo hello' } }, controller.signal);
		assert.deepStrictEqual({ error: result.isError, created }, { error: true, created: 0 });
	});

	test('web fetch blocks local targets and bounds the secure transport result', async () => {
		let requests = 0;
		const fixture = await setupTools(undefined, undefined, async () => { requests++; return 'x'.repeat(60000); });
		const blocked = await fixture.tools.execute({ id: 'private', name: 'web_fetch', mode: 'plan', arguments: { url: 'http://169.254.169.254' } });
		assert.deepStrictEqual({ error: blocked.isError, requests }, { error: true, requests: 0 });
		const large = await fixture.tools.execute({ id: 'public', name: 'web_fetch', mode: 'plan', arguments: { url: 'https://example.com' } });
		assert.deepStrictEqual({ error: large.isError, requests, bounded: large.text.length < 33000 }, { error: undefined, requests: 1, bounded: true });
		assert.match(large.text, /truncated/);
	});

	test('abort and reset cancel real bulk edit preparation before mutation', async () => {
		for (const reset of [false, true]) {
			const fixture = await setupTools();
			const resolver = fixture.instantiation.invokeFunction(accessor => accessor.get(ITextModelService));
			const entered = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			let references = 0;
			fixture.instantiation.stub(ITextModelService, new class extends mock<ITextModelService>() {
				override async createModelReference(resource: URI) {
					if (resource.toString() === fixture.resource.toString() && ++references === 2) {
						await entered.complete();
						await release.p;
					}
					return resolver.createModelReference(resource);
				}
				override createSyntheticDocument(...args: Parameters<ITextModelService['createSyntheticDocument']>) { return resolver.createSyntheticDocument(...args); }
			});
			fixture.instantiation.stub(IBulkEditService, fixture.instantiation.createInstance(BulkEditService));
			const tools = store.add(fixture.instantiation.createInstance(PiAgentTools, fixture.networkFetch));
			const controller = new AbortController();
			const execution = tools.execute({ id: 'edit', name: 'edit_file', mode: 'build', arguments: { path: 'test.ts', oldText: 'original', newText: 'agent edit' } }, controller.signal);
			await entered.p;
			if (reset) { tools.reset(); } else { controller.abort(); }
			await release.complete();
			const result = await execution;
			assert.deepStrictEqual({ error: result.isError, content: fixture.modelService.getModel(fixture.resource)?.getValue() ?? (await fixture.fileService.readFile(fixture.resource)).value.toString() }, { error: true, content: 'original' });
			await tools.rollback(); // A cancelled/no-op bulk edit must not leave a false checkpoint.
		}
	});

	test('abort disposes the dedicated terminal while command dispatch waits', async () => {
		const fixture = await setupTools();
		const capabilities = store.add(new TerminalCapabilityStore());
		const finished = store.add(new Emitter<ITerminalCommand>());
		capabilities.add(TerminalCapability.CommandDetection, new class extends mock<ICommandDetectionCapability>() {
			override readonly onCommandFinished = finished.event;
			override readonly hasRichCommandDetection = true;
		});
		const entered = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		let disposed = false;
		let dispatched = false;
		const terminal = new class extends mock<ITerminalInstance>() {
			override readonly capabilities = capabilities;
			override readonly onExit = Event.None;
			override dispose() { disposed = true; }
			override async runCommand() {
				await entered.complete();
				await release.p;
				// A disposed terminal has no PTY to receive queued input.
				if (!disposed) { dispatched = true; }
			}
		};
		fixture.instantiation.stub(ITerminalService, new class extends mock<ITerminalService>() {
			override async createTerminal() { return terminal; }
			override async revealTerminal() { }
		});
		const tools = store.add(fixture.instantiation.createInstance(PiAgentTools, fixture.networkFetch));
		const controller = new AbortController();
		const execution = tools.execute({ id: 'command', name: 'run_terminal_command', mode: 'build', arguments: { command: 'echo marker' } }, controller.signal);
		await entered.p;
		controller.abort();
		await release.complete();
		const result = await execution;
		assert.deepStrictEqual({ error: result.isError, disposed, dispatched }, { error: true, disposed: true, dispatched: false });
	});

});
