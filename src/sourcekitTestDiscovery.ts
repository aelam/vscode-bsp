import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter,
    CancellationTokenSource, CancellationToken
} from 'vscode-jsonrpc/node';
import type { BspConnection } from './bspConnectionManager';
import type { BuildTarget } from './bspTypes';
import { object, testLocation } from './bspTestRun';
import type { DiscoveredTest, TestDiscovery, TestDiscoveryFactory, TestSelection } from './testDiscovery';

const dataKind = 'sourcekit-test-selection';
function supports(target: BuildTarget): boolean {
    const discovery = object(object(target.data)?.testDiscovery);
    return target.dataKind === 'sourceKit' && target.capabilities.canTest
        && discovery?.provider === 'sourcekit-lsp' && discovery.version === 1
        && discovery.selectionDataKind === dataKind;
}

export const sourcekitTestDiscovery: TestDiscoveryFactory = connection =>
    connection.client.targets.some(supports) ? new SourceKitTestDiscovery(connection) : undefined;

// This adapter owns Swift discovery. The Testing controller uses only TestDiscovery.
class SourceKitTestDiscovery implements TestDiscovery {
    private changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private subscriptions: vscode.Disposable[] = [];
    private child?: ChildProcessWithoutNullStreams;
    private rpc?: MessageConnection;
    private ready?: Promise<void>;
    private documents = new Map<string, { text: string; version: number }>();
    private disposed = false;
    private lifetime = new CancellationTokenSource();

    constructor(private connection: BspConnection) {
        this.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.languageId === 'swift' && e.contentChanges.length) { this.changed.fire(); }
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                if (document.languageId === 'swift') { this.changed.fire(); }
            }),
            vscode.workspace.onDidCreateFiles(() => this.changed.fire()),
            vscode.workspace.onDidDeleteFiles(() => this.changed.fire()),
            vscode.workspace.onDidRenameFiles(() => this.changed.fire())
        );
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(connection.config.workspaceUri, '**/*.swift'));
        this.subscriptions.push(watcher, watcher.onDidChange(() => this.changed.fire()),
            watcher.onDidCreate(() => this.changed.fire()), watcher.onDidDelete(() => this.changed.fire()));
    }

    async discover(targets: BuildTarget[], token: vscode.CancellationToken): Promise<Map<string, DiscoveredTest[]>> {
        targets = targets.filter(supports);
        if (!targets.length) { return new Map(); }
        if (!this.ready) {
            this.ready = this.initialize(targets[0]).catch(error => { this.stop(); throw error; });
        }
        await this.ready;
        if (token.isCancellationRequested || this.disposed) { throw new Error('Test discovery cancelled'); }
        const sources = await this.connection.client.getSources(targets, token);
        const files = new Set(sources.flatMap(item => item.sources)
            .filter(source => source.kind === 1 && source.uri.endsWith('.swift')).map(source => source.uri));
        for (const uri of files) {
            if (token.isCancellationRequested) { throw new Error('Test discovery cancelled'); }
            const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri);
            const text = document ? document.getText() : await fs.readFile(fileURLToPath(uri), 'utf8');
            const previous = this.documents.get(uri);
            if (previous?.text === text) { continue; }
            const version = (previous?.version ?? 0) + 1;
            if (previous) {
                await this.rpc!.sendNotification('textDocument/didChange', {
                    textDocument: { uri, version }, contentChanges: [{ text }]
                });
            } else {
                await this.rpc!.sendNotification('textDocument/didOpen', {
                    textDocument: { uri, languageId: 'swift', version, text }
                });
            }
            this.documents.set(uri, { text, version });
        }
        for (const uri of this.documents.keys()) {
            if (!files.has(uri)) {
                await this.rpc!.sendNotification('textDocument/didClose', { textDocument: { uri } });
                this.documents.delete(uri);
            }
        }
        // Document requests include unsaved edits and do not require a completed index build.
        const discovered = new Map<string, DiscoveredTest[]>();
        for (const uri of files) {
            const result = await this.request<unknown>('textDocument/tests', { textDocument: { uri } }, token);
            if (!Array.isArray(result)) { throw new Error('SourceKit-LSP returned an invalid test list'); }
            discovered.set(uri, result.map(convert).filter((test): test is DiscoveredTest => !!test));
        }
        return new Map(targets.map(target => {
            const owned = sources.find(item => item.target.uri === target.id.uri)?.sources ?? [];
            const tests = [...discovered].filter(([uri]) => owned.some(source => source.uri === uri))
                .flatMap(([, tests]) => tests);
            return [target.id.uri, tests];
        }));
    }

    selection(target: BuildTarget, tests: DiscoveredTest[]): TestSelection {
        if (!supports(target) || !tests.length || tests.some(test => !test.selector || test.disabled)) {
            throw new Error('These tests do not support individual selection');
        }
        return { dataKind, data: { tests: tests.map(test => ({ target: target.id, ...test.selector as object })) } };
    }

    private async initialize(target: BuildTarget): Promise<void> {
        const toolchain = object(target.data)?.toolchain;
        if (typeof toolchain !== 'string') { throw new Error('The server did not provide a Swift toolchain for test discovery'); }
        const root = this.connection.config.workspaceUri.fsPath;
        const configs = (await fs.readdir(path.join(root, '.bsp'))).filter(name => name.endsWith('.json'));
        if (configs.length !== 1) {
            throw new Error('Swift test discovery requires one .bsp configuration in this workspace folder');
        }
        const executable = path.join(fileURLToPath(toolchain), 'usr/bin/sourcekit-lsp');
        const developer = path.resolve(fileURLToPath(toolchain), '../..');
        const child = spawn(executable, [], { cwd: root, env: { ...process.env, DEVELOPER_DIR: developer } });
        this.child = child;
        const rpc = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
        this.rpc = rpc;
        child.stderr.resume();
        child.on('error', () => rpc.dispose());
        child.on('exit', () => { rpc.dispose(); if (this.child === child) { this.ready = undefined; this.documents.clear(); } });
        const folders = [{ uri: this.connection.config.workspaceUri.toString(), name: this.connection.config.name }];
        rpc.onRequest('workspace/configuration', params => params.items.map(() => null));
        rpc.onRequest('workspace/workspaceFolders', () => folders);
        rpc.onRequest('client/registerCapability', () => null);
        rpc.onRequest('window/workDoneProgress/create', () => null);
        rpc.listen();
        const result = await this.request<{ capabilities?: { experimental?: Record<string, unknown> } }>('initialize', {
            processId: process.pid, rootUri: folders[0].uri, workspaceFolders: folders,
            capabilities: { experimental: { 'textDocument/tests': 2, 'workspace/tests': 2 } },
            initializationOptions: { backgroundIndexing: false }
        }, this.lifetime.token);
        const version = object(result.capabilities?.experimental?.['textDocument/tests'])?.version;
        if (typeof version !== 'number' || version < 2) { throw new Error('This SourceKit-LSP version does not support test discovery'); }
        await rpc.sendNotification('initialized', {});
    }

    private async request<T>(method: string, params: unknown, token: vscode.CancellationToken): Promise<T> {
        const cancellation = new CancellationTokenSource();
        let timer: NodeJS.Timeout | undefined;
        let cancel: vscode.Disposable | undefined;
        try {
            return await Promise.race([
                this.rpc!.sendRequest<T>(method, params, cancellation.token),
                new Promise<never>((_resolve, reject) => {
                    const abort = () => { cancellation.cancel(); reject(new Error('Test discovery cancelled')); };
                    cancel = token.onCancellationRequested(abort);
                    if (token.isCancellationRequested) { abort(); }
                    timer = setTimeout(() => { cancellation.cancel(); reject(new Error(`Test discovery timed out: ${method}`)); }, 30000);
                })
            ]);
        } finally {
            if (timer) { clearTimeout(timer); }
            cancel?.dispose();
            cancellation.dispose();
        }
    }

    private stop(): void {
        this.rpc?.dispose();
        const child = this.child;
        if (child && child.exitCode === null) {
            child.kill();
            const timer = setTimeout(() => { if (child.exitCode === null) { child.kill('SIGKILL'); } }, 1000);
            timer.unref();
        }
        this.child = undefined;
        this.rpc = undefined;
        this.ready = undefined;
        this.documents.clear();
    }

    dispose(): void {
        this.disposed = true;
        this.lifetime.cancel();
        this.stop();
        this.lifetime.dispose();
        this.subscriptions.forEach(s => s.dispose());
        this.changed.dispose();
    }
}

export function convert(value: unknown): DiscoveredTest | undefined {
    const test = object(value);
    const location = testLocation(test?.location);
    if (typeof test?.id !== 'string' || typeof test.label !== 'string' || !location || !Array.isArray(test.children)) {
        return undefined;
    }
    // SourceKit-LSP prefixes IDs with the Swift module; xcresult IDs are scoped to the target.
    const dot = test.id.indexOf('.');
    const id = dot >= 0 ? test.id.slice(dot + 1) : test.id;
    const children = test.children.map(convert).filter((child): child is DiscoveredTest => !!child);
    const supported = test.style === 'XCTest' || test.style === 'swift-testing';
    return { id, label: test.label, uri: location.uri, range: location.range, disabled: test.disabled === true,
        children, selector: supported && !children.length && id.endsWith(')') ? { id, style: test.style } : undefined };
}
