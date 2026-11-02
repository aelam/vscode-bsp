import * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import type { BspClient } from './bspClient';
import type { BspConnection, BspConnectionManager } from './bspConnectionManager';
import { BspTestEvent } from './bspTestEvents';
import { BspTestRun } from './bspTestRun';
import { BuildTarget, StatusCode, TaskStartParams } from './bspTypes';
import { taskId } from './bspProgress';
import { logError } from './logger';

interface Target { item: vscode.TestItem; connectionId: string; client: BspClient; target: BuildTarget }
interface Session {
    state: BspTestRun; connectionId: string; owned: boolean;
    cancellation: vscode.Disposable; cancel: () => void;
}

export class BspTesting implements vscode.Disposable {
    readonly controller = vscode.tests.createTestController('bsp-tests', 'BSP Tests');
    private tag = new vscode.TestTag('bsp-test-target');
    private targets = new Map<string, Target>();
    private listeners = new Map<string, vscode.Disposable>();
    private subscriptions: vscode.Disposable[] = [];
    private sessions = new Map<string, Session>();
    private taskOwners = new Map<string, string>();
    private pending = new Map<string, vscode.TestRun>();
    private activeTargets = new Set<string>();
    private batches = new Set<vscode.TestRun>();
    private disposed = false;
    private legacy?: BspConnection;

    constructor(private manager: BspConnectionManager, legacy?: BspClient) {
        if (legacy) {
            this.legacy = {
                id: 'legacy', client: legacy, connected: false,
                config: { name: 'BSP', displayName: 'BSP', configPath: '', workspaceUri: vscode.Uri.file('/') }
            };
        }
        this.controller.createRunProfile('Run Target', vscode.TestRunProfileKind.Run,
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
                item.description = 'Run this target to load test results';
                item.tags = [this.tag];
                this.targets.set(id, { item, connectionId: connection.id, client: connection.client, target });
                keep.add(id);
                items.push(item);
            }
            group.children.replace(items);
            this.controller.items.add(group);
        }
        for (const id of this.targets.keys()) { if (!keep.has(id)) { this.targets.delete(id); } }
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
    }

    private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        if (this.disposed) { return; }
        const run = this.controller.createTestRun(request, 'BSP tests');
        this.batches.add(run);
        const cancellation = new CancellationTokenSource();
        const subscriptions = [token, run.token].map(t => t.onCancellationRequested(() => cancellation.cancel()));
        if (token.isCancellationRequested || run.token.isCancellationRequested) { cancellation.cancel(); }
        const selected = new Map<string, Target>();
        const excludes = request.exclude ?? [];
        const visit = (item: vscode.TestItem) => {
            if (excludes.some(excluded => contains(excluded, item))) { return; }
            const target = this.targets.get(item.id);
            if (target) {
                if (excludes.some(excluded => contains(item, excluded))) {
                    run.errored(item, new vscode.TestMessage('This server cannot exclude individual tests. Select a whole target.'));
                } else { selected.set(item.id, target); }
                return;
            }
            if (item.parent && this.targets.has(item.parent.id)) {
                run.errored(item, new vscode.TestMessage('Individual test selection is not available. Run the containing target.'));
                return;
            }
            for (const [, child] of item.children) { visit(child); }
        };
        for (const item of request.include ?? [...this.controller.items].map(([, item]) => item)) { visit(item); }
        for (const target of selected.values()) { run.enqueued(target.item); }
        try {
            for (const entry of selected.values()) {
                if (this.disposed) { break; }
                if (cancellation.token.isCancellationRequested) { run.skipped(entry.item); continue; }
                if (this.activeTargets.has(entry.item.id) || this.pending.has(entry.item.id)) {
                    run.errored(entry.item, new vscode.TestMessage('Tests for this target are already running'));
                    continue;
                }
                this.pending.set(entry.item.id, run);
                try {
                    await entry.client.test(entry.target, { native: true, token: cancellation.token });
                } catch (error) {
                    if (!this.disposed && !cancellation.token.isCancellationRequested && this.pending.has(entry.item.id)) {
                        run.errored(entry.item, new vscode.TestMessage(String(error)));
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
            const run = prepared ?? this.controller.createTestRun(new vscode.TestRunRequest([entry.item]), entry.item.label);
            const session: Session = {
                state: new BspTestRun(this.controller, run, entry.item, event.target.id.uri),
                connectionId, owned: !prepared,
                cancellation: run.token.onCancellationRequested(event.cancel), cancel: event.cancel
            };
            this.activeTargets.add(entry.item.id);
            this.sessions.set(this.key(connectionId, event.originId), session);
            if (run.token.isCancellationRequested) { event.cancel(); }
        } else if (event.kind === 'finished') {
            this.finish(this.key(connectionId, event.originId), event.status, event.error);
        } else if (event.kind === 'log') {
            if (event.params.originId) {
                this.sessions.get(this.key(connectionId, event.params.originId))?.state.output(event.params.message);
            }
        } else if ('params' in event) {
            const owner = this.owner(connectionId, event.params);
            const session = owner ? this.sessions.get(owner) : undefined;
            if (!session) { return; }
            this.taskOwners.set(this.key(connectionId, taskId(event.params.taskId)), owner!);
            if (event.kind === 'taskStart') { session.state.start(event.params); }
            if (event.kind === 'taskFinish') { session.state.finishTask(event.params); }
            if (event.kind === 'taskProgress' && event.params.message) { session.state.output(event.params.message); }
        }
    }

    private owner(connectionId: string, params: TaskStartParams): string | undefined {
        if (params.originId) {
            const key = this.key(connectionId, params.originId);
            return this.sessions.has(key) ? key : undefined;
        }
        const known = this.taskOwners.get(this.key(connectionId, taskId(params.taskId)));
        if (known) { return known; }
        const parents = typeof params.taskId === 'string' ? [] : params.taskId.parents ?? [];
        return parents.map(parent => this.taskOwners.get(this.key(connectionId, parent))).find(owner => owner !== undefined);
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
        for (const [key, session] of this.sessions) {
            if (session.connectionId === connectionId) { this.finish(key, StatusCode.Error, 'BSP server disconnected'); }
        }
        this.controller.items.delete(connectionId);
        for (const [id, target] of this.targets) { if (target.connectionId === connectionId) { this.targets.delete(id); } }
    }

    dispose(): void {
        if (this.disposed) { return; }
        for (const session of this.sessions.values()) { session.cancel(); }
        for (const key of [...this.sessions.keys()]) { this.finish(key, StatusCode.Cancelled); }
        this.disposed = true;
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
