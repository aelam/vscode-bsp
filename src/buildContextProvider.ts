import * as vscode from 'vscode';
import { logError } from './logger';
import { CancellationToken } from 'vscode-jsonrpc/node';
import type { BspClient } from './bspClient';
import type { BspConnectionManager } from './bspConnectionManager';
import type { BuildTarget } from './bspTypes';
import { ContextBuildPolicy, ContextDimension, ContextOperation, ContextScope, ContextOptions } from './buildContext';
import { contextOptionGroups, contextOptionPresentation, contextOptionTooltip } from './buildContextPresentation';

interface ScopeEntry { connectionId: string; client: BspClient; label: string; scope: ContextScope; target?: BuildTarget }
interface ContextPickItem extends vscode.QuickPickItem { option?: ContextDimension['options'][number] }
function scopeLabel(entry: ScopeEntry): string {
    return `${entry.label} · ${entry.target ? `Target: ${entry.target.displayName ?? entry.target.id.uri}` : 'Workspace'}`;
}
export class ContextTreeItem extends vscode.TreeItem {
    snapshot?: { options: ContextOptions; preferences: string };
    revision = 0;
    constructor(public entry: ScopeEntry, readonly dimension?: ContextDimension,
        operations: readonly ContextOperation[] = []) {
        super(dimension?.label ?? scopeLabel(entry),
            dimension ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
        this.id = JSON.stringify([entry.connectionId, entry.scope.workspaceUri ?? null,
            entry.scope.targets?.map(target => target.uri).sort() ?? null, null, dimension?.id ?? null]);
        this.contextValue = dimension ? dimension.enabled === false ? 'buildContextDimensionDisabled' : 'buildContextDimension'
            : ['buildContextScope', ...operations.map(op => `can${op[0].toUpperCase()}${op.slice(1)}`)].join(' ');
        this.iconPath = new vscode.ThemeIcon(dimension ? 'list-selection' : 'settings-gear');
        if (dimension) {
            const explicit = entry.client.contexts.getSelection(entry.scope)[dimension.id];
            const selected = dimension.options.find(option => option.id === (explicit ?? (dimension.required ? dimension.value : undefined)));
            this.description = dimension.enabled === false ? dimension.reason ?? 'Unavailable'
                : selected?.label ?? (dimension.required ? 'Not selected' : 'Automatic');
            this.tooltip = [`${dimension.label}: ${this.description}`, selected ? contextOptionTooltip(selected) : undefined,
                !selected && !dimension.required ? 'Use the server default when the operation starts.' : undefined,
                dimension.enabled !== false ? dimension.reason : undefined].filter(Boolean).join('\n');
            if (dimension.enabled !== false) {
                this.command = { command: 'bsp.selectContextDimension', title: 'Select Configuration', arguments: [this] };
            }
        }
    }
}

export class BuildContextProvider implements vscode.TreeDataProvider<ContextTreeItem>, vscode.Disposable {
    private changes = new vscode.EventEmitter<ContextTreeItem | undefined>();
    readonly onDidChangeTreeData = this.changes.event;
    private subscriptions: vscode.Disposable[];
    private hooked = new Map<BspClient, BspClient['prepareExecutionContext']>();
    private scopeItems = new Map<string, ContextTreeItem>();
    private scopeLoads = new Map<ContextTreeItem, {
        revision: number; preferences: string; promise: Promise<ContextOptions>;
    }>();

    constructor(private manager: BspConnectionManager, private legacy?: BspClient) {
        this.subscriptions = [manager.onDidChangeConnections(() => this.refresh()), manager.onDidUpdateTargets(() => this.refresh())];
        if (legacy) { this.subscriptions.push(legacy.onTestEvent(event => {
            if (['connected', 'disconnected', 'targets'].includes(event.kind)) { this.refresh(); }
        })); }
        this.installPreparation();
    }

    refresh(): void {
        this.installPreparation();
        const active = new Set(this.entries().map(entry => this.scopeKey(entry)));
        for (const [key, item] of this.scopeItems) {
            item.revision++; item.snapshot = undefined;
            item.contextValue = 'buildContextScope';
            if (!active.has(key)) { this.scopeItems.delete(key); }
        }
        this.changes.fire(undefined);
    }
    dispose(): void {
        this.subscriptions.forEach(subscription => subscription.dispose());
        for (const [client, previous] of this.hooked) { client.prepareExecutionContext = previous; }
        this.hooked.clear(); this.scopeItems.clear(); this.scopeLoads.clear(); this.changes.dispose();
    }
    getTreeItem(item: ContextTreeItem): vscode.TreeItem { return item; }

    getConnectionItem(connectionId: string): ContextTreeItem | undefined {
        const entry = this.entries().find(entry => entry.connectionId === connectionId);
        if (!entry) { return undefined; }
        const item = this.scopeItem(entry);
        item.label = 'Build Context';
        return item;
    }

    async getChildren(item?: ContextTreeItem): Promise<ContextTreeItem[]> {
        if (!item) {
            const entries = this.entries();
            const active = new Set(entries.map(entry => this.scopeKey(entry)));
            for (const key of this.scopeItems.keys()) { if (!active.has(key)) { this.scopeItems.delete(key); } }
            return Promise.all(entries.map(async entry => {
                const item = this.scopeItem(entry);
                try {
                    await this.loadScope(item, true);
                } catch {
                    item.snapshot = undefined;
                    item.contextValue = 'buildContextScope';
                    item.description = 'Configuration needs attention';
                }
                return item;
            }));
        }
        if (item.dimension || !item.entry.client.connected) { return []; }
        try {
            const result = await this.loadScope(item);
            return result.dimensions.map(dimension => new ContextTreeItem(item.entry,
                { ...dimension, value: dimension.value ?? result.selection[dimension.id] }));
        } catch (error) {
            void vscode.window.showErrorMessage(`Cannot load build configuration: ${String(error)}`);
            return [];
        }
    }

    async configure(item?: { connectionId?: string; buildTarget?: BuildTarget } | ContextTreeItem): Promise<void> {
        const entry = await this.entryFor(item);
        if (!entry) { return; }
        let result: ContextOptions | undefined;
        while (entry.client.connected) {
            try { result ??= await entry.client.contexts.options(entry.scope); }
            catch (error) {
                const choice = await vscode.window.showWarningMessage(
                    `Cannot load the saved configuration: ${String(error)}`, 'Reset saved choices');
                if (choice !== 'Reset saved choices') { return; }
                await entry.client.contexts.reset(entry.scope); this.refresh(); result = undefined; continue;
            }
            const choices = result.dimensions.map(dimension => {
                const row = new ContextTreeItem(entry,
                    { ...dimension, value: dimension.value ?? result!.selection[dimension.id] });
                return { label: dimension.label, description: row.description as string, detail: row.tooltip as string,
                    dimension, action: 'dimension' };
            });
            const selected = await vscode.window.showQuickPick([
                ...choices, { label: 'Reset saved choices', action: 'reset' }
            ], { placeHolder: `${scopeLabel(entry)} · shared configuration` });
            if (!selected) { return; }
            if (selected.action === 'reset') {
                await entry.client.contexts.reset(entry.scope); this.refresh(); result = undefined;
            }
            else if ('dimension' in selected) {
                await this.selectDimension(new ContextTreeItem(entry, selected.dimension),
                    CancellationToken.None, false, options => { result = options; });
            }
        }
    }

    async selectDimension(item: ContextTreeItem, token = CancellationToken.None, requireChoice = false,
        onChanged?: (options: ContextOptions) => void): Promise<boolean> {
        const { entry, dimension } = item;
        if (!dimension || dimension.enabled === false) { return false; }
        const current = await entry.client.contexts.options(entry.scope, undefined, token);
        const fresh = current.dimensions.find(candidate => candidate.id === dimension.id);
        if (!fresh) { this.refresh(); return false; }
        if (fresh.enabled === false) { this.refresh(); return false; }
        if (fresh.kind !== 'enum') {
            void vscode.window.showInformationMessage(`This client cannot edit the ${fresh.kind} configuration type`);
            return false;
        }
        const automatic: ContextPickItem[] = requireChoice || fresh.required ? [] : [{
            label: 'Automatic', description: 'Use the server default',
            detail: 'The server chooses a value when the operation starts.',
            iconPath: new vscode.ThemeIcon('settings-gear')
        }];
        const recent = fresh.options.length < 5 ? [] : entry.client.contexts.recentOptions(entry.scope, fresh.id)
            .flatMap(id => {
                const option = fresh.options.find(option => option.id === id && option.availability !== false);
                return option ? [option] : [];
            });
        const groups = contextOptionGroups(fresh.options);
        if (recent.length) {
            if (!groups[0]?.label && groups.length) { groups[0].label = 'All options'; }
            groups.unshift({ label: 'Recent', options: recent });
        }
        const choices: ContextPickItem[] = [...automatic];
        for (const group of groups) {
            if (group.label) { choices.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator }); }
            choices.push(...group.options.map(option => {
                const { icon, ...presentation } = contextOptionPresentation(option);
                return { ...presentation, iconPath: icon ? new vscode.ThemeIcon(icon) : undefined, option };
            }));
        }
        const explicit = entry.client.contexts.getSelection(entry.scope)[fresh.id];
        const selected = explicit ?? (fresh.required ? current.selection[fresh.id] ?? fresh.value : undefined);
        const active = choices.find(choice => choice.kind !== vscode.QuickPickItemKind.Separator
            && choice.option?.id === selected);
        const chosen = await this.pick(choices, fresh.label, active, token);
        if (!chosen || token.isCancellationRequested) { return false; }
        if (chosen.option?.availability === false) {
            void vscode.window.showInformationMessage(chosen.option.reason ?? 'This option is unavailable'); return false;
        }
        const result = await entry.client.contexts.choose(entry.scope, fresh.id, chosen.option?.id, current.dimensions, token);
        if (chosen.option) {
            try { await entry.client.contexts.rememberOption(entry.scope, fresh.id, chosen.option.id); }
            catch (error) { logError('Failed to save recent configuration choices', error); }
        }
        onChanged?.(result);
        const root = this.scopeItems.get(this.scopeKey(entry));
        if (root?.entry.client === entry.client) {
            root.revision++;
            this.updateScope(root, result, this.preferenceKey(entry));
            this.changes.fire(root);
        }
        return true;
    }

    private pick(items: ContextPickItem[], title: string, active: ContextPickItem | undefined,
        token: CancellationToken): Promise<ContextPickItem | undefined> {
        if (token.isCancellationRequested) { return Promise.resolve(undefined); }
        return new Promise(resolve => {
            const picker = vscode.window.createQuickPick<ContextPickItem>();
            picker.title = title;
            picker.matchOnDescription = true;
            picker.matchOnDetail = true;
            picker.items = items;
            if (active) { picker.activeItems = [active]; }
            let finished = false;
            const subscriptions: vscode.Disposable[] = [];
            const finish = (value?: ContextPickItem): void => {
                if (finished) { return; }
                finished = true;
                subscriptions.forEach(subscription => subscription.dispose());
                picker.dispose();
                resolve(value);
            };
            subscriptions.push(picker.onDidAccept(() => {
                const selected = picker.selectedItems[0];
                if (selected && selected.kind !== vscode.QuickPickItemKind.Separator) { finish(selected); }
            }), picker.onDidHide(() => finish()), token.onCancellationRequested(() => finish()));
            picker.show();
        });
    }

    private scopeKey(entry: ScopeEntry): string {
        return JSON.stringify([entry.connectionId, entry.scope.workspaceUri ?? null,
            entry.scope.targets?.map(target => target.uri).sort() ?? null]);
    }

    private preferenceKey(entry: ScopeEntry): string {
        return JSON.stringify(Object.entries(entry.client.contexts.getSelection(entry.scope)).sort(([a], [b]) => a.localeCompare(b)));
    }

    private scopeItem(entry: ScopeEntry): ContextTreeItem {
        const key = this.scopeKey(entry), existing = this.scopeItems.get(key);
        if (existing?.entry.client === entry.client) {
            existing.entry = entry;
            existing.label = scopeLabel(entry);
            return existing;
        }
        const item = new ContextTreeItem(entry);
        this.scopeItems.set(key, item);
        return item;
    }

    private async loadScope(item: ContextTreeItem, fresh = false): Promise<ContextOptions> {
        const preferences = this.preferenceKey(item.entry), revision = item.revision;
        if (!fresh && item.snapshot?.preferences === preferences) { return item.snapshot.options; }
        const pending = this.scopeLoads.get(item);
        if (pending?.revision === revision && pending.preferences === preferences) { return pending.promise; }
        const current = (): boolean => item.revision === revision && this.preferenceKey(item.entry) === preferences;
        const promise = item.entry.client.contexts.options(item.entry.scope).then(options => {
            if (!current()) { return this.loadScope(item); }
            this.updateScope(item, options, preferences);
            return options;
        }, error => {
            if (!current()) { return this.loadScope(item); }
            throw error;
        });
        this.scopeLoads.set(item, { revision, preferences, promise });
        try { return await promise; }
        finally { if (this.scopeLoads.get(item)?.promise === promise) { this.scopeLoads.delete(item); } }
    }

    private updateScope(item: ContextTreeItem, options: ContextOptions, preferences: string): void {
        item.snapshot = { options, preferences };
        item.contextValue = ['buildContextScope', ...this.operations(item.entry, options)
            .map(op => `can${op[0].toUpperCase()}${op.slice(1)}`),
            ...(item.entry.client.contexts.supportsReuse ? ['canReuseBuild'] : [])].join(' ');
        item.description = undefined;
    }

    async execute(item: ContextTreeItem, operation?: ContextOperation, buildPolicy: ContextBuildPolicy = 'build'): Promise<void> {
        if (operation) { item.entry.client.contexts.requireBuildPolicy(operation, buildPolicy); }
        const shared = await item.entry.client.contexts.options(item.entry.scope);
        const available = this.operations(item.entry, shared);
        const selected = operation ?? (await vscode.window.showQuickPick(available.map(operation => ({ label: operation, operation })),
            { placeHolder: 'Select an operation' }))?.operation;
        if (!selected) { return; }
        if (!available.includes(selected)) { throw new Error(`This scope does not support ${selected}`); }
        await item.entry.client.executeContext(selected, item.entry.scope, undefined, {}, true, [], buildPolicy);
    }

    private async prepare(entry: ScopeEntry, operation: ContextOperation, token: CancellationToken): Promise<boolean> {
        while (!token.isCancellationRequested) {
            const { options, selection: selected, sharedScope, sharedDimensions } =
                await entry.client.contexts.executionOptions(entry.scope, operation, token);
            const missing = options.dimensions.find(dimension => dimension.required && dimension.enabled !== false && dimension.kind === 'enum'
                && (selected[dimension.id] ?? options.selection[dimension.id] ?? dimension.value) === undefined);
            if (!missing) { return true; }
            const shared = sharedDimensions.includes(missing.id);
            const promptScope = shared ? sharedScope : entry.scope;
            if (!await this.selectDimension(new ContextTreeItem({ ...entry, scope: promptScope }, missing), token, true)) { return false; }
        }
        return false;
    }

    private operations(entry: ScopeEntry, options: ContextOptions): ContextOperation[] {
        return (options.operations ?? entry.client.contexts.operations).filter(operation =>
            entry.client.contexts.operations.includes(operation) && entry.client.supportsOperation(operation, entry.target));
    }

    private async entryFor(item?: { connectionId?: string; buildTarget?: BuildTarget } | ContextTreeItem): Promise<ScopeEntry | undefined> {
        let entry: ScopeEntry | undefined;
        if (item instanceof ContextTreeItem) { return item.entry; }
        if (item?.connectionId) { entry = this.entries().find(entry => entry.connectionId === item.connectionId); }
        else if (item?.buildTarget && this.legacy?.contexts.enabled) {
            entry = this.entries().find(entry => entry.client === this.legacy);
        }
        if ((item?.connectionId || item?.buildTarget) && !entry) {
            void vscode.window.showInformationMessage('This target has no connected server with execution context support'); return;
        }
        if (!entry) {
            const entries = this.entries();
            if (!entries.length) { void vscode.window.showInformationMessage('No connected server supports execution contexts'); return; }
            entry = entries.length === 1 ? entries[0]
                : (await vscode.window.showQuickPick(entries.map(entry => ({ label: entry.label, entry })),
                    { placeHolder: 'Select a BSP workspace' }))?.entry;
        }
        if (entry && item?.buildTarget) {
            entry = { ...entry, target: item.buildTarget,
                scope: { targets: [item.buildTarget.id] } };
        }
        return entry;
    }

    private installPreparation(): void {
        for (const entry of this.entries()) {
            if (this.hooked.has(entry.client)) { continue; }
            this.hooked.set(entry.client, entry.client.prepareExecutionContext);
            entry.client.prepareExecutionContext = (scope, operation, token) => this.prepare({ ...entry, scope }, operation, token);
        }
    }

    private entries(): ScopeEntry[] {
        const entries = this.manager.getConnectedClients().filter(({ client }) => client.contexts.enabled)
            .map(({ client, connectionId, config }) => ({ client, connectionId,
                label: config.displayName ?? config.name, scope: {} }));
        if (this.legacy?.connected && this.legacy.contexts.enabled && !entries.some(entry => entry.client === this.legacy)) {
            entries.push({ client: this.legacy, connectionId: 'legacy', label: 'BSP', scope: {} });
        }
        return entries;
    }
}
