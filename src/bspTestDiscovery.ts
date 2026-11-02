import * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import type { BspConnection } from './bspConnectionManager';
import type { BuildTarget } from './bspTypes';
import type { DiscoveredTest, TestDiscovery, TestDiscoveryFactory, TestSelection } from './testDiscovery';

export interface DiscoveryTarget { item: vscode.TestItem; connectionId: string; target: BuildTarget }
interface ProviderState {
    provider: TestDiscovery; listener: vscode.Disposable; signature: string;
    generation: number; pending: Promise<void>; token?: CancellationTokenSource; timer?: NodeJS.Timeout;
}
export interface DiscoveredItem { target: DiscoveryTarget; test: DiscoveredTest; item: vscode.TestItem }

export class BspTestDiscovery implements vscode.Disposable {
    private providers = new Map<string, ProviderState>();
    private targets: DiscoveryTarget[] = [];
    private models = new Map<string, DiscoveredItem>();
    private catalogs = new Map<string, Map<string, vscode.TestItem>>();
    private disposed = false;

    constructor(
        private controller: vscode.TestController, private tag: vscode.TestTag,
        private factories: TestDiscoveryFactory[], private running: (targetId: string) => boolean
    ) {}

    sync(connections: BspConnection[], targets: DiscoveryTarget[]): void {
        this.targets = targets;
        for (const id of this.providers.keys()) {
            if (!connections.some(c => c.id === id && c.connected && c.client.connected)) { this.remove(id); }
        }
        for (const targetId of this.catalogs.keys()) {
            if (!targets.some(t => t.item.id === targetId)) { this.catalogs.delete(targetId); }
        }
        for (const [id, model] of this.models) {
            if (!targets.some(t => t.item.id === model.target.item.id)) { this.models.delete(id); }
        }
        for (const connection of connections.filter(c => c.connected && c.client.connected)) {
            let state = this.providers.get(connection.id);
            const signature = JSON.stringify(targets.filter(t => t.connectionId === connection.id).map(t => t.target));
            if (!state) {
                let provider: TestDiscovery | undefined;
                for (const factory of this.factories) { provider = factory(connection); if (provider) { break; } }
                if (!provider) { continue; }
                state = { provider, listener: provider.onDidChange(() => this.schedule(connection.id)),
                    signature: '', generation: 0, pending: Promise.resolve() };
                this.providers.set(connection.id, state);
            }
            if (signature !== state.signature) { state.signature = signature; this.schedule(connection.id); }
        }
    }

    model(item: vscode.TestItem): DiscoveredItem | undefined { return this.models.get(item.id); }
    catalog(target: vscode.TestItem): Map<string, vscode.TestItem> | undefined { return this.catalogs.get(target.id); }

    selection(target: DiscoveryTarget, items: vscode.TestItem[]): TestSelection {
        const provider = this.providers.get(target.connectionId)?.provider;
        const tests = items.map(item => this.models.get(item.id)?.test);
        if (!provider || !tests.length || tests.some(test => !test || !test.selector || test.disabled)) {
            throw new Error('Individual test selection is not available for these tests');
        }
        return provider.selection(target.target, tests as DiscoveredTest[]);
    }

    private schedule(connectionId: string): void {
        const state = this.providers.get(connectionId);
        if (!state || this.disposed) { return; }
        state.generation++;
        state.token?.cancel();
        if (state.timer) { clearTimeout(state.timer); }
        state.timer = setTimeout(() => { state.timer = undefined; void this.refreshConnection(connectionId); }, 350);
    }

    async refresh(token?: vscode.CancellationToken): Promise<void> {
        await Promise.all([...this.providers.keys()].map(id => this.refreshConnection(id, token)));
    }

    private async refreshConnection(connectionId: string, external?: vscode.CancellationToken): Promise<void> {
        const state = this.providers.get(connectionId);
        if (!state || this.disposed || external?.isCancellationRequested) { return; }
        if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
        if (this.targets.some(t => t.connectionId === connectionId && this.running(t.item.id))) {
            this.schedule(connectionId); return;
        }
        const generation = ++state.generation;
        state.token?.cancel();
        const token = new CancellationTokenSource();
        state.token = token;
        const subscription = external?.onCancellationRequested(() => token.cancel());
        state.pending = state.pending.then(async () => {
            if (token.token.isCancellationRequested || this.disposed) { return; }
            const targets = this.targets.filter(t => t.connectionId === connectionId);
            try {
                const result = await state.provider.discover(targets.map(t => t.target), token.token);
                if (this.disposed || token.token.isCancellationRequested || generation !== state.generation) { return; }
                if (targets.some(t => this.running(t.item.id))) { this.schedule(connectionId); return; }
                for (const target of targets) {
                    const tests = result.get(target.target.id.uri);
                    if (tests) { this.apply(target, tests); }
                }
            } catch (error) {
                if (!this.disposed && !token.token.isCancellationRequested && generation === state.generation) {
                    for (const target of targets) { target.item.error = `Test discovery failed: ${String(error)}`; }
                }
            }
        }).finally(() => { subscription?.dispose(); token.dispose(); });
        await state.pending;
    }

    private apply(target: DiscoveryTarget, tests: DiscoveredTest[]): void {
        const previous = this.catalogs.get(target.item.id);
        const catalog = new Map<string, vscode.TestItem>();
        const models = new Map<string, DiscoveredItem>();
        const build = (test: DiscoveredTest, disabled: boolean): vscode.TestItem => {
            disabled = disabled || test.disabled;
            if (catalog.has(test.id)) { throw new Error(`Duplicate test identifier: ${test.id}`); }
            const cached = previous?.get(test.id);
            const item = (cached?.uri?.toString() === test.uri.toString() ? cached : undefined)
                ?? this.controller.createTestItem(JSON.stringify([target.item.id, test.id]), test.label, test.uri);
            catalog.set(test.id, item);
            item.label = test.label;
            item.range = test.range;
            item.description = disabled ? 'Disabled' : undefined;
            const children = test.children.map(child => build(child, disabled));
            item.children.replace(children);
            item.tags = !disabled && (test.selector || children.some(child => child.tags.length)) ? [this.tag] : [];
            models.set(item.id, { target, item, test: { ...test, disabled } });
            return item;
        };
        const roots = mergeTests(tests).map(test => build(test, false));
        for (const [id, model] of this.models) {
            if (model.target.item.id === target.item.id) { this.models.delete(id); }
        }
        for (const [id, model] of models) { this.models.set(id, model); }
        this.catalogs.set(target.item.id, catalog);
        target.item.children.replace(roots);
        target.item.description = tests.length ? undefined : 'No tests discovered';
        target.item.error = undefined;
    }

    remove(connectionId: string): void {
        const state = this.providers.get(connectionId);
        if (!state) { return; }
        state.generation++;
        state.token?.cancel();
        if (state.timer) { clearTimeout(state.timer); }
        state.listener.dispose();
        state.provider.dispose();
        this.providers.delete(connectionId);
        for (const [id, model] of this.models) {
            if (model.target.connectionId === connectionId) { this.models.delete(id); this.catalogs.delete(model.target.item.id); }
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const id of this.providers.keys()) { this.remove(id); }
        this.models.clear();
        this.catalogs.clear();
    }
}

function mergeTests(tests: DiscoveredTest[]): DiscoveredTest[] {
    const merged = new Map<string, DiscoveredTest>();
    for (const test of tests) {
        const previous = merged.get(test.id);
        if (!previous) { merged.set(test.id, { ...test, children: mergeTests(test.children) }); continue; }
        if (previous.selector || test.selector) {
            if (previous.uri.toString() !== test.uri.toString()
                || JSON.stringify(previous.range) !== JSON.stringify(test.range)) {
                throw new Error(`Ambiguous test identifier: ${test.id}`);
            }
        } else { previous.children = mergeTests([...previous.children, ...test.children]); }
    }
    return [...merged.values()];
}
