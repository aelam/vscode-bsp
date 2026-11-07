import * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import type { BspClient } from './bspClient';
import type { BspConnection, BspConnectionManager } from './bspConnectionManager';
import { BspTestEvent } from './bspTestEvents';
import { BspTestRun, object } from './bspTestRun';
import { BuildTarget, StatusCode, TaskStartParams } from './bspTypes';
import { taskId } from './bspProgress';
import { logError } from './logger';
import { BspTestDiscovery } from './bspTestDiscovery';
import type { TestDiscoveryFactory } from './testDiscovery';

interface Target { item: vscode.TestItem; connectionId: string; client: BspClient; target: BuildTarget }
interface Session {
    state: BspTestRun; connectionId: string; originId: string; owned: boolean;
    cancellation: vscode.Disposable; cancel: () => void;
}

export class BspTesting implements vscode.Disposable {
    readonly controller = vscode.tests.createTestController('bsp-tests', 'BSP Tests');
    private tag = new vscode.TestTag('bsp-test-target');
    private debugTag = new vscode.TestTag('bsp-debug-test-target');
    private debugProfile?: vscode.TestRunProfile;
    private debugStarts = new Map<string, CancellationTokenSource>();
    private targets = new Map<string, Target>();
    private listeners = new Map<string, vscode.Disposable>();
    private subscriptions: vscode.Disposable[] = [];
    private sessions = new Map<string, Session>();
    private taskOwners = new Map<string, string>();
    private pending = new Map<string, { run: vscode.TestRun; selected?: vscode.TestItem[] }>();
    private discovery: BspTestDiscovery;
    private activeTargets = new Set<string>();
    private batches = new Set<vscode.TestRun>();
    private disposed = false;
    private legacy?: BspConnection;

    constructor(private manager: BspConnectionManager, legacy?: BspClient, factories: TestDiscoveryFactory[] = []) {
        this.discovery = new BspTestDiscovery(this.controller, this.tag, factories,
            id => this.activeTargets.has(id) || this.pending.has(id) || this.debugStarts.has(id));
        if (legacy) {
            this.legacy = {
                id: 'legacy', client: legacy, connected: false,
                config: { name: 'BSP', displayName: 'BSP', configPath: '', workspaceUri: vscode.Uri.file('/') }
            };
        }
        this.controller.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run,
            (request, token) => this.run(request, token), true, this.tag);
        this.controller.refreshHandler = token => this.refresh(token);
        this.controller.resolveHandler = item => item ? undefined : this.refresh();
        this.subscriptions.push(
            manager.onDidChangeConnections(() => this.sync()),
            manager.onDidUpdateTargets(() => this.sync())
        );
        this.sync();
    }

    private connections(): BspConnection[] {
        const result = this.manager.getAllConnections();
        return this.legacy ? [...result, { ...this.legacy, connected: this.legacy.client.connected }] : result;
    }

    private sync(): void {
        if (this.disposed) { return; }
        const connections = this.connections();
        const ids = new Set(connections.map(c => c.id));
        for (const [id, listener] of this.listeners) {
            if (ids.has(id)) { continue; }
            this.disconnected(id);
            listener.dispose();
            this.listeners.delete(id);
        }
        const keep = new Set<string>();
        for (const connection of connections) {
            if (!this.listeners.has(connection.id)) {
                this.listeners.set(connection.id, connection.client.onTestEvent(event => this.event(connection.id, event)));
                if (connection.client.connected) { void this.loadTargets(connection.client); }
            }
            if (!connection.connected || !connection.client.connected || !connection.client.supportsTesting) {
                this.controller.items.delete(connection.id);
                continue;
            }
            const group = this.controller.items.get(connection.id)
                ?? this.controller.createTestItem(connection.id, connection.config.displayName ?? connection.config.name);
            group.label = connection.config.displayName ?? connection.config.name;
            const items: vscode.TestItem[] = [];
            for (const target of connection.client.targets.filter(t => t.capabilities.canTest)) {
                const id = this.targetId(connection.id, target.id.uri);
                const item = this.targets.get(id)?.item
                    ?? this.controller.createTestItem(id, target.displayName ?? target.id.uri);
                item.label = target.displayName ?? target.id.uri;
                if (!this.discovery.catalog(item)) { item.description = 'Run this target to load test results'; }
                item.tags = target.capabilities.canDebug ? [this.tag, this.debugTag] : [this.tag];
                this.targets.set(id, { item, connectionId: connection.id, client: connection.client, target });
                keep.add(id);
                items.push(item);
            }
            group.children.replace(items);
            this.controller.items.add(group);
        }
        for (const id of this.targets.keys()) { if (!keep.has(id)) { this.targets.delete(id); } }
        this.syncDebugProfile();
        this.discovery.sync(connections, [...this.targets.values()]);
    }

    private syncDebugProfile(): void {
        for (const [id, cancellation] of this.debugStarts) {
            if (!this.targets.get(id)?.target.capabilities.canDebug) { cancellation.cancel(); }
        }
        const supported = [...this.targets.values()].some(entry => entry.target.capabilities.canDebug);
        if (supported && !this.debugProfile) {
            this.debugProfile = this.controller.createRunProfile('Debug Test Target', vscode.TestRunProfileKind.Debug,
                (request, token) => this.debug(request, token), true, this.debugTag);
        } else if (!supported && this.debugProfile) {
            this.debugProfile.dispose();
            this.debugProfile = undefined;
        }
    }

    private async debug(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        if (this.disposed || token.isCancellationRequested) { return; }
        let cancellation: CancellationTokenSource | undefined;
        let subscription: vscode.Disposable | undefined;
        let entry: Target | undefined;
        try {
            const selected = new Map<string, Target>();
            const excludes = request.exclude ?? [];
            const visit = (item: vscode.TestItem) => {
                if (excludes.some(exclude => contains(exclude, item))) { return; }
                const target = this.targets.get(item.id);
                if (target) {
                    if (!target.target.capabilities.canDebug) { return; }
                    if (excludes.some(exclude => contains(item, exclude))) {
                        throw new Error('Debug runs the entire test target. Individual test exclusions are not supported.');
                    }
                    selected.set(item.id, target);
                    return;
                }
                if (this.discovery.model(item) || (item.parent && this.targets.has(item.parent.id))) {
                    throw new Error('Select a whole test target. Individual test debugging is not supported.');
                }
                for (const [, child] of item.children) { visit(child); }
            };
            for (const item of request.include ?? [...this.controller.items].map(([, item]) => item)) { visit(item); }
            if (selected.size !== 1) { throw new Error('Select one test target that supports debugging.'); }
            entry = [...selected.values()][0];
            if (this.activeTargets.has(entry.item.id) || this.pending.has(entry.item.id) || this.debugStarts.has(entry.item.id)) {
                throw new Error('Tests for this target are already running');
            }
            cancellation = new CancellationTokenSource();
            this.debugStarts.set(entry.item.id, cancellation);
            const source = cancellation;
            subscription = token.onCancellationRequested(() => source.cancel());
            if (token.isCancellationRequested) { source.cancel(); }
            for (const document of vscode.workspace?.textDocuments ?? []) {
                if (source.token.isCancellationRequested) { return; }
                if (document.isDirty && !await document.save()) { throw new Error('Save test files before debugging tests'); }
            }
            if (source.token.isCancellationRequested) { return; }
            if (entry.target.capabilities.canCompile && !entry.client.contexts?.enabled) {
                const result = await entry.client.compile(entry.target, source.token);
                if (source.token.isCancellationRequested || result.statusCode === StatusCode.Cancelled) { return; }
                if (result.statusCode !== StatusCode.Ok) { throw new Error('Build failed. The test debugger was not started.'); }
            }
            if (source.token.isCancellationRequested || this.disposed) { return; }
            const current = this.targets.get(entry.item.id);
            if (!entry.client.connected || current?.client !== entry.client || !current.target.capabilities.canDebug) {
                throw new Error('This test target is no longer available for debugging.');
            }
            await entry.client.debugTests(current.target, source.token);
        } catch (error) {
            if (!this.disposed && !token.isCancellationRequested && !cancellation?.token.isCancellationRequested) {
                void vscode.window.showErrorMessage(`Cannot debug tests: ${String(error)}`);
            }
        } finally {
            subscription?.dispose();
            if (entry && cancellation && this.debugStarts.get(entry.item.id) === cancellation) {
                this.debugStarts.delete(entry.item.id);
            }
            cancellation?.dispose();
        }
    }

    private async loadTargets(client: BspClient): Promise<void> {
        try { await client.getBuildTargets(); }
        catch (error) { logError('Failed to refresh test targets', error); }
    }

    private async refresh(token?: vscode.CancellationToken): Promise<void> {
        for (const connection of this.connections()) {
            if (token?.isCancellationRequested || this.disposed) { break; }
            if (connection.client.connected) { await this.loadTargets(connection.client); }
        }
        this.sync();
        await this.discovery.refresh(token);
    }

    private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        if (this.disposed) { return; }
        const run = this.controller.createTestRun(request, 'BSP tests');
        this.batches.add(run);
        const cancellation = new CancellationTokenSource();
        const subscriptions = [token, run.token].map(t => t.onCancellationRequested(() => cancellation.cancel()));
        if (token.isCancellationRequested || run.token.isCancellationRequested) { cancellation.cancel(); }
        const selected = new Map<string, { entry: Target; items?: vscode.TestItem[] }>();
        const excludes = request.exclude ?? [];
        const excluded = (item: vscode.TestItem) => excludes.some(exclude => contains(exclude, item));
        const selectCase = (item: vscode.TestItem) => {
            if (excluded(item)) { return; }
            const model = this.discovery.model(item);
            if (model?.test.disabled) { run.skipped(item); return; }
            if (model && item.children.size) {
                for (const [, child] of item.children) { selectCase(child); }
                return;
            }
            const entry = model && this.targets.get(model.target.item.id);
            if (!entry || !model.test.selector) {
                run.errored(item, new vscode.TestMessage('Individual test selection is not available. Run the containing target.'));
                return;
            }
            const previous = selected.get(entry.item.id);
            if (previous && !previous.items) { return; }
            const items = previous?.items ?? [];
            if (!items.includes(item)) { items.push(item); }
            selected.set(entry.item.id, { entry, items });
        };
        const visit = (item: vscode.TestItem) => {
            if (excluded(item)) { return; }
            const entry = this.targets.get(item.id);
            if (entry) {
                if (excludes.some(exclude => contains(item, exclude))) {
                    if (!this.discovery.catalog(item)) {
                        run.errored(item, new vscode.TestMessage('This server cannot exclude individual tests. Select a whole target.'));
                    } else { for (const [, child] of item.children) { selectCase(child); } }
                } else { selected.set(item.id, { entry }); }
                return;
            }
            if (this.discovery.model(item) || (item.parent && this.targets.has(item.parent.id))) { selectCase(item); return; }
            for (const [, child] of item.children) { visit(child); }
        };
        for (const item of request.include ?? [...this.controller.items].map(([, item]) => item)) { visit(item); }
        for (const { entry, items } of selected.values()) {
            run.enqueued(entry.item);
            items?.forEach(item => run.enqueued(item));
        }
        try {
            for (const { entry, items } of selected.values()) {
                if (this.disposed) { break; }
                if (cancellation.token.isCancellationRequested) {
                    run.skipped(entry.item); items?.forEach(item => run.skipped(item)); continue;
                }
                if (this.activeTargets.has(entry.item.id) || this.pending.has(entry.item.id) || this.debugStarts.has(entry.item.id)) {
                    run.errored(entry.item, new vscode.TestMessage('Tests for this target are already running'));
                    continue;
                }
                this.pending.set(entry.item.id, { run, selected: items });
                try {
                    const selection = items ? this.discovery.selection(entry, items) : undefined;
                    const files = new Set(items?.map(item => item.uri?.toString()));
                    for (const document of vscode.workspace?.textDocuments ?? []) {
                        if (document.isDirty && (items ? files.has(document.uri.toString()) : true) && !await document.save()) {
                            throw new Error('Save test files before running tests');
                        }
                    }
                    await entry.client.test(entry.target, { native: true, token: cancellation.token, selection });
                } catch (error) {
                    if (!this.disposed && !cancellation.token.isCancellationRequested && this.pending.has(entry.item.id)) {
                        run.errored(entry.item, new vscode.TestMessage(String(error)));
                        items?.forEach(item => run.errored(item, new vscode.TestMessage(String(error))));
                    }
                } finally { this.pending.delete(entry.item.id); }
            }
        } finally {
            subscriptions.forEach(s => s.dispose());
            cancellation.dispose();
            if (this.batches.delete(run)) { run.end(); }
        }
    }

    private event(connectionId: string, event: BspTestEvent): void {
        if (this.disposed) { return; }
        if (event.kind === 'connected') {
            const client = this.connections().find(c => c.id === connectionId)?.client;
            if (client) { void this.loadTargets(client); }
            this.sync();
        } else if (event.kind === 'targets') { this.sync(); }
        else if (event.kind === 'disconnected') { this.disconnected(connectionId); }
        else if (event.kind === 'started') {
            const entry = this.targets.get(this.targetId(connectionId, event.target.id.uri));
            if (!entry) { return; }
            const prepared = this.pending.get(entry.item.id);
            this.pending.delete(entry.item.id);
            const run = prepared?.run ?? this.controller.createTestRun(new vscode.TestRunRequest([entry.item]), entry.item.label);
            const catalog = this.discovery.catalog(entry.item);
            const session: Session = {
                state: new BspTestRun(this.controller, run, entry.item, event.target.id.uri,
                    catalog ? { items: new Map(catalog), selected: prepared?.selected } : undefined),
                connectionId, originId: event.originId, owned: !prepared,
                cancellation: run.token.onCancellationRequested(event.cancel), cancel: event.cancel
            };
            this.activeTargets.add(entry.item.id);
            this.sessions.set(this.key(connectionId, JSON.stringify([event.originId, event.target.id.uri])), session);
            if (run.token.isCancellationRequested) { event.cancel(); }
        } else if (event.kind === 'finished') {
            for (const [key, session] of this.sessions) {
                if (session.connectionId === connectionId && session.originId === event.originId) {
                    this.finish(key, event.status, event.error);
                }
            }
        } else if (event.kind === 'log') {
            if (event.params.originId) {
                for (const session of this.sessions.values()) {
                    if (session.connectionId === connectionId && session.originId === event.params.originId) {
                        session.state.log(event.params.message, event.params.type);
                    }
                }
            }
        } else if ('params' in event) {
            const owner = this.owner(connectionId, event.params);
            const session = owner ? this.sessions.get(owner) : undefined;
            if (!session) { return; }
            this.taskOwners.set(this.key(connectionId, taskId(event.params.taskId)), owner!);
            if (event.kind === 'taskStart') { session.state.start(event.params); }
            if (event.kind === 'taskFinish') { session.state.finishTask(event.params); }
            if (event.kind === 'taskProgress' && event.params.message) {
                session.state.output(event.params.message, session.state.target, 'progress');
            }
        }
    }

    private owner(connectionId: string, params: TaskStartParams): string | undefined {
        const target = ['test-task', 'test-report'].includes(params.dataKind ?? '')
            ? object(object(params.data)?.target)?.uri : undefined;
        const compatible = (key: string | undefined) => {
            const session = key ? this.sessions.get(key) : undefined;
            return !!session && (!params.originId || session.originId === params.originId)
                && (typeof target !== 'string' || session.state.targetUri === target);
        };
        const known = this.taskOwners.get(this.key(connectionId, taskId(params.taskId)));
        if (compatible(known)) { return known; }
        const parents = typeof params.taskId === 'string' ? [] : params.taskId.parents ?? [];
        const parent = parents.map(parent => this.taskOwners.get(this.key(connectionId, parent))).find(compatible);
        if (parent) { return parent; }
        // Some servers omit originId and identify the test request by its target.
        const matches = [...this.sessions].filter(([, session]) => session.connectionId === connectionId
            && (!params.originId || session.originId === params.originId)
            && (typeof target !== 'string' || session.state.targetUri === target)
            && (params.originId || typeof target === 'string'));
        return matches.length === 1 ? matches[0][0] : undefined;
    }

    private finish(key: string, status: StatusCode, error?: string): void {
        const session = this.sessions.get(key);
        if (!session) { return; }
        this.sessions.delete(key);
        this.activeTargets.delete(session.state.target.id);
        session.cancellation.dispose();
        session.state.finish(status, error);
        if (session.owned) { session.state.run.end(); }
        for (const [task, owner] of this.taskOwners) { if (owner === key) { this.taskOwners.delete(task); } }
    }

    private disconnected(connectionId: string): void {
        for (const [id, cancellation] of this.debugStarts) {
            if (this.targets.get(id)?.connectionId === connectionId) { cancellation.cancel(); }
        }
        this.discovery.remove(connectionId);
        for (const [key, session] of this.sessions) {
            if (session.connectionId === connectionId) { this.finish(key, StatusCode.Error, 'BSP server disconnected'); }
        }
        this.controller.items.delete(connectionId);
        for (const [id, target] of this.targets) { if (target.connectionId === connectionId) { this.targets.delete(id); } }
        this.syncDebugProfile();
    }

    dispose(): void {
        if (this.disposed) { return; }
        for (const session of this.sessions.values()) { session.cancel(); }
        for (const key of [...this.sessions.keys()]) { this.finish(key, StatusCode.Cancelled); }
        this.disposed = true;
        for (const cancellation of this.debugStarts.values()) { cancellation.cancel(); }
        this.debugProfile?.dispose();
        this.debugProfile = undefined;
        this.discovery.dispose();
        this.subscriptions.forEach(s => s.dispose());
        this.listeners.forEach(s => s.dispose());
        this.batches.forEach(run => run.end());
        this.batches.clear();
        this.listeners.clear();
        this.targets.clear();
        this.pending.clear();
        this.controller.dispose();
    }

    private targetId(connectionId: string, uri: string): string { return this.key(connectionId, uri); }
    private key(connectionId: string, value: string): string { return JSON.stringify([connectionId, value]); }
}

function contains(parent: vscode.TestItem, item: vscode.TestItem): boolean {
    for (let current: vscode.TestItem | undefined = item; current; current = current.parent) {
        if (current.id === parent.id) { return true; }
    }
    return false;
}
