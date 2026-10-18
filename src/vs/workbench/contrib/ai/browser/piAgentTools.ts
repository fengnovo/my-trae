/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout, raceCancellationError } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { AIConfig } from '../../../../platform/ai/common/aiConfiguration.js';
import { IPiToolRequest, IPiToolResult } from '../../../../platform/ai/common/piAgent.js';
import { ICodeIndexService } from '../../../../platform/ai/common/codeIndex.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { assertPiToolAllowed, exactPiEdit, piWorkspaceResource, validatePiWebUrl } from '../common/piToolPolicy.js';

interface ICheckpoint {
	readonly resource: URI;
	readonly original: string | undefined;
	lastWrite: string;
	diskAtWrite: string | undefined;
}

const maxText = 32000;
const maxFile = 512 * 1024;

/** IDE execution boundary for Pi. No model instruction can bypass these permission checks. */
export class PiAgentTools extends Disposable {
	private readonly activeOperations = new Set<CancellationTokenSource>();
	private readonly memoryScheme = `pi-memory-${generateUuid()}`;
	private readonly checkpoints = new Map<string, ICheckpoint>();
	private readonly memoryListeners = this._register(new DisposableStore());
	private readonly memoryModels = new Map<string, URI>();
	private generation = 0;
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly networkFetch: (url: string, signal?: AbortSignal) => Promise<string>,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IFileService private readonly fileService: IFileService,
		@IModelService private readonly modelService: IModelService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@IEditorService private readonly editorService: IEditorService,
		@IDialogService private readonly dialogService: IDialogService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ICodeIndexService private readonly indexService: ICodeIndexService,
	) {
		super();
		this._register(fileService.registerProvider(this.memoryScheme, this._register(new InMemoryFileSystemProvider())));
		this._register(workspaceService.onDidChangeWorkspaceFolders(() => this.reset()));
	}

	/** Clear session-scoped rollback history when the workspace/session changes. */
	reset(): void {
		this.generation++;
		for (const operation of this.activeOperations) {
			operation.cancel();
		}
		this.checkpoints.clear();
	}

	override dispose(): void {
		this.reset();
		super.dispose();
	}

	/** Serialize tool calls so two approvals cannot silently race each other. */
	execute(request: IPiToolRequest, signal?: AbortSignal): Promise<IPiToolResult> {
		const generation = this.generation;
		const result = this.pending.then(async () => {
			try {
				this.checkActive(generation, signal);
				assertPiToolAllowed(request.name, request.mode, this.trustService.isWorkspaceTrusted());
				const result = await this.run(request, generation, signal);
				return typeof result === 'string' ? { text: this.bound(result) } : { ...result, text: this.bound(result.text) };
			} catch (error) {
				return { text: this.bound(getErrorMessage(error)), isError: true };
			}
		});
		this.pending = result.then(() => undefined);
		return result;
	}

	private get fullAccess(): boolean { return this.configurationService.getValue<string>(AIConfig.AgentAccessMode) === 'fullAccess'; }

	private root(): URI {
		const root = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!root) {
			throw new Error(localize('pi.noWorkspace', "Open a workspace folder first."));
		}
		return root;
	}

	private checkActive(generation: number, signal?: AbortSignal): void {
		if (signal?.aborted || generation !== this.generation) {
			throw new Error(localize('pi.cancelled', "Agent tool cancelled."));
		}
		if (!this.trustService.isWorkspaceTrusted()) {
			throw new Error(localize('pi.untrusted', "Trust this workspace before using agent tools."));
		}
	}

	/** Propagate abort/reset through asynchronous service preparation to its final mutation check. */
	private cancellation(generation: number, signal: AbortSignal | undefined, store: DisposableStore): CancellationTokenSource {
		const source = store.add(new CancellationTokenSource());
		this.activeOperations.add(source);
		store.add(toDisposable(() => this.activeOperations.delete(source)));
		const abort = () => source.cancel();
		signal?.addEventListener('abort', abort, { once: true });
		store.add(toDisposable(() => signal?.removeEventListener('abort', abort)));
		if (signal?.aborted || generation !== this.generation) {
			source.cancel();
		}
		return source;
	}

	private bound(value: string): string {
		return value.length > maxText ? value.slice(0, maxText) + localize('pi.truncated', "\n[Result truncated]") : value;
	}

	/** Reject every symlink ancestor, including the workspace root, rather than following it. */
	private async safeResource(path: string, allowMissing = false): Promise<URI> {
		const root = this.root();
		const resource = piWorkspaceResource(root, path);
		let current = resource;
		while (true) {
			if (await this.fileService.exists(current)) {
				const stat = await this.fileService.resolve(current);
				if (stat.isSymbolicLink) {
					throw new Error(localize('pi.symlink', "Agent tools cannot follow symbolic links."));
				}
			} else if (!allowMissing || !isEqual(current, resource)) {
				throw new Error(localize('pi.missingPath', "The file or its parent directory does not exist."));
			}
			const parent = dirname(current);
			if (isEqual(parent, current)) {
				break;
			}
			current = parent;
		}
		return resource;
	}

	private async read(resource: URI): Promise<string> {
		const model = this.modelService.getModel(resource);
		if (model) {
			if (model.getValueLength() > maxFile) {
				throw new Error(localize('pi.largeFile', "The file exceeds the agent size limit."));
			}
			return model.getValue();
		}
		return (await this.fileService.readFile(resource, { limits: { size: maxFile } })).value.toString();
	}

	private async run(request: IPiToolRequest, generation: number, signal?: AbortSignal): Promise<string | IPiToolResult> {
		const args = request.arguments;
		switch (request.name) {
			case 'read_file': {
				const text = await this.read(await this.safeResource(args.path ?? ''));
				const start = Math.max(1, args.startLine ?? 1);
				const end = Math.max(start, args.endLine ?? start + 999);
				return text.split(/\r?\n/).slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
			}
			case 'list_dir': {
				const stat = await this.fileService.resolve(await this.safeResource(args.path ?? ''));
				const children = stat.children ?? [];
				return children.length === 0 ? localize('pi.emptyDirectory', "The directory is empty.") : children.slice(0, 500).map(child => `${child.name}${child.isSymbolicLink ? ' [symlink, blocked]' : child.isDirectory ? '/' : ''}`).join('\n');
			}
			case 'search_code': return this.search(args.path ?? '', args.query ?? '', args.maxResults ?? 30, generation, signal);
			case 'get_diagnostics': {
				const resource = args.path ? await this.safeResource(args.path) : undefined;
				return JSON.stringify(this.markerService.read({ resource }).filter(marker => isEqualOrParent(marker.resource, this.root())).slice(0, 100).map(marker => ({ path: marker.resource.path, line: marker.startLineNumber, column: marker.startColumn, severity: marker.severity, message: marker.message })));
			}
			case 'write_file':
			case 'edit_file': {
				const resource = await this.safeResource(args.path ?? '', request.name === 'write_file');
				const exists = await this.fileService.exists(resource);
				if (!exists && this.modelService.getModel(resource)) {
					throw new Error(localize('pi.modelCollision', "An unsaved editor already owns this path."));
				}
				const before = exists ? await this.read(resource) : undefined;
				if (request.name === 'write_file' && args.content === undefined || request.name === 'edit_file' && (args.oldText === undefined || args.newText === undefined)) {
					throw new Error(localize('pi.contentRequired', "Supply the content or both oldText and newText."));
				}
				const after = request.name === 'edit_file' ? exactPiEdit(before ?? '', args.oldText!, args.newText!) : args.content!;
				await this.approveAndWrite(resource, before, after, generation, signal, true);
				return localize('pi.writeComplete', "Applied edit with undo support. Rollback checkpoints last for this IDE session.");
			}
			case 'run_terminal_command': {
				const command = args.command?.trim();
				if (!command) {
					throw new Error(localize('pi.commandRequired', "Supply a terminal command."));
				}
				const cwd = await this.safeResource(args.path ?? '');
				const confirmation = this.fullAccess ? { confirmed: true } : await this.dialogService.confirm({ type: 'warning', message: localize('pi.runCommand', "Run this agent command?"), detail: localize('pi.commandDetail', "Working directory: {0}\n\n{1}\n\nCommands can modify files and access resources outside the workspace. Command changes are not covered by agent rollback.", cwd.fsPath, command), primaryButton: localize('pi.run', "Run Command") });
				this.checkActive(generation, signal);
				if (!confirmation.confirmed) {
					throw new Error(localize('pi.declined', "User declined the agent action."));
				}
				await this.safeResource(args.path ?? '');
				this.checkActive(generation, signal);
				const terminal = await this.terminalService.createTerminal({ cwd });
				return this.runTerminal(terminal, command, generation, signal);
			}
			case 'remember':
			case 'search_memory': return this.memory(request, generation, signal);
			case 'web_search': {
				const endpoint = this.configurationService.getValue<string>('myTrae.agent.searchUrl');
				if (!endpoint) {
					throw new Error(localize('pi.searchMissing', "Configure myTrae.agent.searchUrl with a SearxNG-compatible JSON search endpoint first."));
				}
				const url = validatePiWebUrl(endpoint);
				url.searchParams.set('q', args.query ?? '');
				url.searchParams.set('format', 'json');
				return this.fetch(url.toString(), generation, signal);
			}
			case 'web_fetch': return this.fetch(args.url ?? '', generation, signal);
			case 'update_plan': return localize('pi.planOwned', "Plan updates are handled by the Pi session.");
		}
	}

	private async search(path: string, query: string, maxResults: number, generation: number, signal?: AbortSignal): Promise<string> {
		if (!query) {
			throw new Error(localize('pi.queryRequired', "Supply a nonempty search query."));
		}
		const limit = Math.max(1, Math.min(100, maxResults));
		const semantic = await this.semanticSearch(query, Math.min(8, limit));
		this.checkActive(generation, signal);
		const lexical = await this.lexicalSearch(path, query, limit, generation, signal);
		if (!semantic) {
			return lexical;
		}
		return `${semantic}\n${lexical ? `\n${lexical}` : localize('pi.searchNoLexical', "\n[No further literal matches]")}`;
	}

	/** Vector + keyword retrieval from the workspace index; empty when it is unavailable. */
	private async semanticSearch(query: string, maxResults: number): Promise<string> {
		try {
			const hits = await this.indexService.search({ text: query, maxResults });
			if (hits.length === 0) {
				return '';
			}
			return localize('pi.searchSemantic', "Semantic matches from the workspace index:") + '\n' + hits.map(hit => `${hit.path}:${hit.startLine}-${hit.endLine}\n${hit.text.slice(0, 600)}`).join('\n\n');
		} catch (error) {
			return localize('pi.searchSemanticUnavailable', "[Workspace index unavailable: {0}]", getErrorMessage(error));
		}
	}

	private async lexicalSearch(path: string, query: string, limit: number, generation: number, signal?: AbortSignal): Promise<string> {
		const queue = [await this.safeResource(path)];
		const results: string[] = [];
		let visited = 0;
		while (queue.length && visited++ < 1000 && results.length < limit) {
			this.checkActive(generation, signal);
			const resource = queue.shift()!;
			const stat = await this.fileService.resolve(resource);
			if (stat.isSymbolicLink) {
				continue;
			}
			await this.safeResource(resource.path);
			if (stat.isDirectory) {
				queue.push(...(stat.children ?? []).filter(child => !child.isSymbolicLink && !['.git', 'node_modules'].includes(child.name)).map(child => child.resource));
			} else if (stat.isFile) {
				try {
					const text = await this.read(resource);
					if (!text.includes('\0')) {
						for (const [index, line] of text.split(/\r?\n/).entries()) {
							if (line.includes(query)) {
								results.push(`${resource.path}:${index + 1}: ${line.slice(0, 500)}`);
								if (results.length >= limit) { break; }
							}
						}
					}
				} catch { /* Unreadable, binary or oversized files are not search candidates. */ }
			}
		}
		return results.join('\n') + (queue.length ? localize('pi.searchLimited', "\n[Search limited to 1000 entries and the requested result count]") : '');
	}

	/** Capture correlated shell-integration output when available; never infer success from sending text. */
	private async runTerminal(terminal: ITerminalInstance, command: string, generation: number, signal?: AbortSignal): Promise<IPiToolResult> {
		const resources = new DisposableStore();
		const cancellation = this.cancellation(generation, signal, resources);
		resources.add(cancellation.token.onCancellationRequested(() => terminal.dispose()));
		try {
			if (cancellation.token.isCancellationRequested) {
				terminal.dispose();
			}
			this.checkActive(generation, signal);
			await this.terminalService.revealTerminal(terminal);
			this.checkActive(generation, signal);
			if (!terminal.capabilities.get(TerminalCapability.CommandDetection)) {
				await new Promise<void>(resolve => {
					resources.add(disposableTimeout(resolve, 3000));
					resources.add(terminal.capabilities.onDidAddCommandDetectionCapability(() => resolve()));
					resources.add(cancellation.token.onCancellationRequested(() => resolve()));
				});
			}
			this.checkActive(generation, signal);
			const detection = terminal.capabilities.get(TerminalCapability.CommandDetection);
			if (!detection?.hasRichCommandDetection) {
				await raceCancellationError(terminal.sendText(command, true), cancellation.token);
				this.checkActive(generation, signal);
				return { text: localize('pi.terminalOutput', "Command sent to the IDE terminal. Inspect its output there: completion, exit status, and output are not captured by this tool. Do not assume success.") };
			}
			const id = generateUuid();
			const completion = new Promise<IPiToolResult>(resolve => {
				resources.add(detection.onCommandFinished(finished => {
					if (finished.id === id) {
						resolve({ text: localize('pi.commandFinished', "Exit code: {0}\n{1}", finished.exitCode ?? localize('pi.exitUnknown', "unknown"), this.bound(finished.getOutput() ?? localize('pi.noOutput', "No output was captured."))), ...(typeof finished.exitCode === 'number' ? { exitCode: finished.exitCode, ...(finished.exitCode !== 0 ? { isError: true } : {}) } : {}) });
					}
				}));
				resources.add(terminal.onExit(() => resolve({ text: localize('pi.terminalExited', "The terminal exited before correlated command output was available. Inspect the terminal.") })));
				resources.add(disposableTimeout(() => resolve({ text: localize('pi.commandTimeout', "Output capture timed out after 60 seconds. The command may still be running in the IDE terminal.") }), 60000));
				resources.add(cancellation.token.onCancellationRequested(() => resolve({ text: localize('pi.commandCancelled', "Agent command cancelled and its dedicated terminal closed.") })));
			});
			this.checkActive(generation, signal);
			await raceCancellationError(terminal.runCommand(command, true, id), cancellation.token);
			this.checkActive(generation, signal);
			return await completion;
		} finally {
			resources.dispose();
		}
	}

	/** Show a real diff, then check both disk and live model again after approval. */
	private async approveAndWrite(resource: URI, before: string | undefined, after: string | undefined, generation: number, signal?: AbortSignal, checkpoint = false, expectedDisk?: string): Promise<void> {
		if ((after?.length ?? 0) > maxFile) {
			throw new Error(localize('pi.largeFile', "The file exceeds the agent size limit."));
		}
		const store = new DisposableStore();
		const cancellation = this.cancellation(generation, signal, store);
		try {
			const reference = before !== undefined ? store.add(await this.textModelService.createModelReference(resource)) : undefined;
			const version = reference?.object.textEditorModel.getVersionId();
			const diskBefore = await this.fileService.exists(resource) ? (await this.fileService.readFile(resource, { limits: { size: maxFile } })).value.toString() : undefined;
			if (expectedDisk !== undefined && diskBefore !== expectedDisk && diskBefore !== before) {
				throw new Error(localize('pi.diskConflict', "The file has subsequent disk changes. They were preserved."));
			}
			const original = store.add(await this.textModelService.createSyntheticDocument(before ?? '', null));
			const modified = store.add(await this.textModelService.createSyntheticDocument(after ?? '', null));
			await this.editorService.openEditor({ original: { resource: original.object.textEditorModel.uri }, modified: { resource: modified.object.textEditorModel.uri }, label: localize('pi.preview', "Agent Edit Preview: {0}", resource.path) });
			this.checkActive(generation, signal);
			const approval = this.fullAccess ? { confirmed: true } : await this.dialogService.confirm({ type: 'warning', message: localize('pi.applyEdit', "Apply the previewed agent edit?"), detail: resource.fsPath, primaryButton: localize('pi.apply', "Apply Edit") });
			this.checkActive(generation, signal);
			if (!approval.confirmed) {
				throw new Error(localize('pi.declined', "User declined the agent action."));
			}
			await this.safeResource(resource.path, before === undefined);
			const diskNow = await this.fileService.exists(resource) ? (await this.fileService.readFile(resource, { limits: { size: maxFile } })).value.toString() : undefined;
			if (original.object.textEditorModel.getValue() !== (before ?? '') || modified.object.textEditorModel.getValue() !== (after ?? '') || diskNow !== diskBefore || reference && (reference.object.textEditorModel.getVersionId() !== version || reference.object.textEditorModel.getValue() !== before) || !reference && this.modelService.getModel(resource)) {
				throw new Error(localize('pi.staleEdit', "The file changed during approval. Read it again before editing."));
			}
			this.checkActive(generation, signal);
			const edits = after === undefined ? [new ResourceFileEdit(resource, undefined)] : reference ? [new ResourceTextEdit(resource, { range: reference.object.textEditorModel.getFullModelRange(), text: after }, version)] : [new ResourceFileEdit(undefined, resource, { overwrite: false, contents: Promise.resolve(VSBuffer.fromString(after)) })];
			const key = resource.toString();
			const previous = this.checkpoints.get(key);
			const result = await this.bulkEditService.apply(edits, { label: localize('pi.editLabel', "Pi Agent Edit"), confirmBeforeUndo: true, token: cancellation.token });
			if (!result.isApplied) {
				throw new Error(localize('pi.notApplied', "The edit was not applied."));
			}
			// A cancelled token makes BulkEditService skip every edit while still reporting
			// success, so liveness must be verified before trusting `isApplied`.
			this.checkActive(generation, signal);
			if (checkpoint && after !== undefined) {
				// Record only after the mutation actually landed so an aborted/no-op apply
				// cannot leave a false checkpoint that rollback would mistake for a
				// subsequent user edit. Values still describe the state captured before
				// the first modification.
				this.checkpoints.set(key, { resource, original: previous ? previous.original : before, lastWrite: after, diskAtWrite: before === undefined ? after : diskBefore });
			}
		} finally {
			store.dispose();
		}
	}

	/** Restore only files which still match the last agent write. Never use Git reset/stash. */
	rollback(): Promise<void> {
		const result = this.pending.then(() => this.restoreCheckpoints());
		this.pending = result.catch(() => undefined);
		return result;
	}

	private async restoreCheckpoints(): Promise<void> {
		const generation = this.generation;
		this.checkActive(generation);
		for (const [key, checkpoint] of this.checkpoints) {
			await this.safeResource(checkpoint.resource.path);
			const disk = (await this.fileService.readFile(checkpoint.resource, { limits: { size: maxFile } })).value.toString();
			if (await this.read(checkpoint.resource) !== checkpoint.lastWrite || (disk !== checkpoint.diskAtWrite && disk !== checkpoint.lastWrite)) {
				throw new Error(localize('pi.rollbackConflict', "Rollback stopped: {0} has subsequent edits. They were preserved.", checkpoint.resource.path));
			}
			await this.approveAndWrite(checkpoint.resource, checkpoint.lastWrite, checkpoint.original, generation, undefined, false, checkpoint.diskAtWrite);
			this.checkpoints.delete(key);
		}
	}

	/** Editable plain text persisted in application storage under a workspace-specific key. */
	private async memory(request: IPiToolRequest, generation: number, signal?: AbortSignal): Promise<string> {
		const key = `myTrae.pi.memory.${this.root().toString()}`;
		let uri = this.memoryModels.get(key);
		let model = uri ? this.modelService.getModel(uri) : null;
		if (!model) {
			uri = URI.from({ scheme: this.memoryScheme, path: `/project-memory-${this.memoryModels.size + 1}.md` });
			await this.fileService.writeFile(uri, VSBuffer.fromString(this.storageService.get(key, StorageScope.APPLICATION, '')));
			const reference = await this.textModelService.createModelReference(uri);
			this.memoryListeners.add(reference);
			model = reference.object.textEditorModel;
			this.memoryModels.set(key, uri);
			const memoryModel = model;
			const fileModel = this.textFileService.files.get(uri);
			this.memoryListeners.add(model.onDidChangeContent(() => {
				this.storageService.store(key, memoryModel.getValue(), StorageScope.APPLICATION, StorageTarget.MACHINE);
				// Persist every user keystroke; saving the private memory file also keeps its editor clean.
				void fileModel?.save();
			}));
		}
		if (request.name === 'search_memory') {
			const query = (request.arguments.query ?? '').toLowerCase();
			return model.getValue().split('\n').filter(line => line.toLowerCase().includes(query)).join('\n');
		}
		const content = request.arguments.content;
		if (content === undefined || model.getValueLength() + content.length > maxFile) {
			throw new Error(localize('pi.memoryContent', "Supply memory text within the 512 KB workspace memory limit."));
		}
		const version = model.getVersionId();
		await this.editorService.openEditor({ resource: model.uri, options: { pinned: true } });
		const approval = this.fullAccess ? { confirmed: true } : await this.dialogService.confirm({ message: localize('pi.remember', "Append this text to project memory?"), detail: content, primaryButton: localize('pi.saveMemory', "Save Memory") });
		this.checkActive(generation, signal);
		if (!approval.confirmed || model.getVersionId() !== version) {
			throw new Error(localize('pi.memoryDeclined', "Memory was changed or approval was declined. No agent text was saved."));
		}
		model.pushStackElement();
		model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: model.getValue() + (model.getValueLength() ? '\n' : '') + content }], () => null);
		model.pushStackElement();
		await this.textFileService.files.get(model.uri)?.save();
		return localize('pi.memorySaved', "Saved project memory. Edit the open memory document to update it.");
	}

	private async fetch(value: string, generation: number, signal?: AbortSignal): Promise<string> {
		const url = validatePiWebUrl(value);
		this.checkActive(generation, signal);
		// The utility-process transport resolves and pins public addresses before connecting,
		// bounds decoded bytes while receiving, and links cancellation to the agent session.
		const result = await this.networkFetch(url.toString(), signal);
		this.checkActive(generation, signal);
		return this.bound(result);
	}
}
