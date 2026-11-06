import * as vscode from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc/node';
import type { BspClient } from './bspClient';
import type { BspConnectionManager } from './bspConnectionManager';
import type { BuildTarget } from './bspTypes';
import { ContextDimension, ContextOperation, ContextScope, ContextOptions } from './buildContext';
import { contextOptionDetail, contextOptionTooltip } from './buildContextPresentation';

interface ScopeEntry { connectionId: string; client: BspClient; label: string; scope: ContextScope; target?: BuildTarget }
export class ContextTreeItem extends vscode.TreeItem {
    constructor(readonly entry: ScopeEntry, readonly operation?: ContextOperation, readonly dimension?: ContextDimension,
        operations: readonly ContextOperation[] = []) {
        super(dimension?.label ?? entry.label,
            dimension ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
        this.id = JSON.stringify([entry.connectionId, entry.scope.targets ?? null, operation, dimension?.id]);
        this.contextValue = dimension ? dimension.enabled === false ? 'buildContextDimensionDisabled' : 'buildContextDimension'
            : ['buildContextScope', ...operations.map(op => `can${op[0].toUpperCase()}${op.slice(1)}`)].join(' ');
        this.iconPath = new vscode.ThemeIcon(dimension ? 'list-selection' : 'settings-gear');
        if (dimension) {
            const selected = dimension.options.find(option => option.id === dimension.value);
            this.description = dimension.enabled === false ? dimension.reason ?? 'Unavailable'
                : selected?.label ?? 'Automatic';
            this.tooltip = [`${dimension.label}: ${this.description}`, selected ? contextOptionTooltip(selected) : undefined,
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
    private targetScopes = new Map<string, ScopeEntry>();
    private subscriptions: vscode.Disposable[];
    private hooked = new Map<BspClient, BspClient['prepareExecutionContext']>();

    constructor(private manager: BspConnectionManager, private legacy?: BspClient) {
        this.subscriptions = [manager.onDidChangeConnections(() => this.refresh()), manager.onDidUpdateTargets(() => this.refresh())];
        if (legacy) { this.subscriptions.push(legacy.onTestEvent(event => {
            if (['connected', 'disconnected', 'targets'].includes(event.kind)) { this.refresh(); }
        })); }
        this.installPreparation();
    }

    refresh(): void { this.installPreparation(); this.changes.fire(undefined); }
    dispose(): void {
        this.subscriptions.forEach(subscription => subscription.dispose());
        for (const [client, previous] of this.hooked) { client.prepareExecutionContext = previous; }
        this.hooked.clear(); this.changes.dispose();
    }
    getTreeItem(item: ContextTreeItem): vscode.TreeItem { return item; }

    async getChildren(item?: ContextTreeItem): Promise<ContextTreeItem[]> {
        if (!item) {
            const entries = this.entries();
            for (const entry of this.targetScopes.values()) {
                if (entry.client.connected && entry.client.contexts.enabled) { entries.push(entry); }
            }
            return Promise.all(entries.map(async entry => {
                try {
                    const options = await entry.client.contexts.options(entry.scope);
                    return new ContextTreeItem(entry, undefined, undefined, this.operations(entry, options));
                } catch {
                    const result = new ContextTreeItem(entry);
                    result.description = 'Configuration needs attention';
                    return result;
                }
            }));
        }
        if (item.dimension || !item.entry.client.connected) { return []; }
        try {
            const result = await item.entry.client.contexts.options(item.entry.scope);
            return result.dimensions.map(dimension => new ContextTreeItem(item.entry, undefined,
                { ...dimension, value: dimension.value ?? result.selection[dimension.id] }));
        } catch (error) {
            void vscode.window.showErrorMessage(`Cannot load build configuration: ${String(error)}`);
            return [];
        }
    }

    async configure(item?: { connectionId?: string; buildTarget?: BuildTarget } | ContextTreeItem,
        overrides = false): Promise<void> {
        const entry = await this.entryFor(item);
        if (!entry) { return; }
        let operation: ContextOperation | undefined;
        if (overrides) {
            const shared = await entry.client.contexts.options(entry.scope);
            operation = (await vscode.window.showQuickPick(this.operations(entry, shared).map(operation => ({ label: operation, operation })),
                { placeHolder: 'Select an operation to override shared choices' }))?.operation;
            if (!operation) { return; }
        }
        while (entry.client.connected) {
            let result: ContextOptions;
            try { result = await entry.client.contexts.options(entry.scope, operation); }
            catch (error) {
                const choice = await vscode.window.showWarningMessage(
                    `Cannot load the saved configuration: ${String(error)}`, 'Reset saved choices');
                if (choice !== 'Reset saved choices') { return; }
                await entry.client.contexts.reset(entry.scope, operation); this.refresh(); continue;
            }
            const choices = result.dimensions.map(dimension => ({
                label: dimension.label,
                description: dimension.enabled === false ? dimension.reason ?? 'Unavailable'
                    : dimension.options.find(option => option.id === (dimension.value ?? result.selection[dimension.id]))?.label ?? 'Automatic',
                detail: dimension.enabled === false ? dimension.reason : contextOptionTooltip(
                    dimension.options.find(option => option.id === (dimension.value ?? result.selection[dimension.id]))) ?? dimension.reason,
                dimension, action: 'dimension'
            }));
            const actions = operation ? [operation] : this.operations(entry, result);
            const selected = await vscode.window.showQuickPick([
                ...choices, ...actions.map(op => ({ label: `Execute ${op}`, action: 'execute', operation: op })),
                { label: 'Reset saved choices', action: 'reset' }
            ], { placeHolder: `${entry.label}${operation ? ` · ${operation} overrides` : ' · shared configuration'}` });
            if (!selected) { return; }
            if (selected.action === 'execute' && 'operation' in selected) {
                await this.execute(new ContextTreeItem(entry), selected.operation); return;
            }
            if (selected.action === 'reset') { await entry.client.contexts.reset(entry.scope, operation); this.refresh(); }
            else if ('dimension' in selected) {
                await this.selectDimension(new ContextTreeItem(entry, operation, selected.dimension));
            }
        }
    }

    async selectDimension(item: ContextTreeItem, token = CancellationToken.None, requireChoice = false): Promise<boolean> {
        const { entry, operation, dimension } = item;
        if (!dimension || dimension.enabled === false) { return false; }
        const current = await entry.client.contexts.options(entry.scope, operation, undefined, token);
        const fresh = current.dimensions.find(candidate => candidate.id === dimension.id);
        if (!fresh) { this.refresh(); return false; }
        if (fresh.enabled === false) { this.refresh(); return false; }
        if (fresh.kind !== 'enum') {
            void vscode.window.showInformationMessage(`This client cannot edit the ${fresh.kind} configuration type`);
            return false;
        }
        const automatic = requireChoice ? [] : [{ label: 'Automatic', description: 'Use the server default', option: undefined }];
        const chosen = await vscode.window.showQuickPick([
            ...automatic, ...fresh.options.map(option => ({ label: option.label, description: option.description,
                detail: contextOptionDetail(option), option }))
        ], { placeHolder: fresh.label }, token);
        if (!chosen || token.isCancellationRequested) { return false; }
        if (chosen.option?.availability === false) {
            void vscode.window.showInformationMessage(chosen.option.reason ?? 'This option is unavailable'); return false;
        }
        await entry.client.contexts.choose(entry.scope, fresh.id, chosen.option?.id, current.dimensions, operation, token);
        this.refresh(); return true;
    }

    async execute(item: ContextTreeItem, operation?: ContextOperation): Promise<void> {
        const shared = await item.entry.client.contexts.options(item.entry.scope);
        const available = this.operations(item.entry, shared);
        const selected = operation ?? (await vscode.window.showQuickPick(available.map(operation => ({ label: operation, operation })),
            { placeHolder: 'Select an operation' }))?.operation;
        if (!selected) { return; }
        if (!available.includes(selected)) { throw new Error(`This scope does not support ${selected}`); }
        await item.entry.client.executeContext(selected, item.entry.scope);
    }

    private async prepare(entry: ScopeEntry, operation: ContextOperation, token: CancellationToken): Promise<boolean> {
        while (!token.isCancellationRequested) {
            const shared = await entry.client.contexts.options(entry.scope, undefined, undefined, token);
            const options = await entry.client.contexts.options(entry.scope, operation, undefined, token);
            const selected = entry.client.contexts.getSelection(entry.scope, operation);
            const missing = options.dimensions.find(dimension => dimension.required && dimension.enabled !== false && dimension.kind === 'enum'
                && (selected[dimension.id] ?? options.selection[dimension.id] ?? dimension.value) === undefined);
            if (!missing) { return true; }
            const sharedDimension = shared.dimensions.find(dimension => dimension.id === missing.id && dimension.enabled !== false);
            if (!await this.selectDimension(new ContextTreeItem(entry, sharedDimension ? undefined : operation,
                sharedDimension ?? missing), token, true)) { return false; }
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
            entry = { client: this.legacy, connectionId: 'legacy', label: 'BSP workspace', scope: {} };
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
                label: `${entry.label} · ${item.buildTarget.displayName ?? item.buildTarget.id.uri}`, scope: { targets: [item.buildTarget.id] } };
            this.targetScopes.set(JSON.stringify([entry.connectionId, item.buildTarget.id.uri]), entry); this.refresh();
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
        if (this.legacy?.connected && this.legacy.contexts.enabled) {
            entries.push({ client: this.legacy, connectionId: 'legacy', label: 'BSP workspace', scope: {} });
        }
        return entries;
    }
}
