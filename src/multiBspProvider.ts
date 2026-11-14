import * as vscode from 'vscode';
import * as path from 'path';
import { BspConnectionManager, BspConnection } from './bspConnectionManager';
import { BuildTarget, BuildTargetIdentifier } from './bspTypes';
import { logError, logInfo } from './logger';
import { BuildContextProvider, ContextTreeItem } from './buildContextProvider';
import { connectionActivity } from './bspConnectionActivity';

export type BspExplorerItem = BspTreeItem | ContextTreeItem;

export class MultiBspProvider implements vscode.TreeDataProvider<BspExplorerItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<BspExplorerItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private favoriteTargets = new Map<string, Set<string>>();
    private legacyFavorites = new Set<string>();
    private context?: vscode.ExtensionContext;

    private subscriptions: vscode.Disposable[];

    constructor(private connectionManager: BspConnectionManager, context?: vscode.ExtensionContext,
        private contexts?: BuildContextProvider) {
        this.context = context;
        const updateTargets = () => { this.migrateLegacyFavorites(); this.refresh(); };
        this.subscriptions = [
            connectionManager.onDidChangeConnections(updateTargets),
            connectionManager.onDidChangeOperations(() => this.refresh()),
            connectionManager.onDidChangeBackgroundTasks(() => this.refresh()),
            connectionManager.onDidUpdateTargets(updateTargets)
        ];
        if (contexts) {
            this.subscriptions.push(contexts.onDidChangeTreeData(item => this._onDidChangeTreeData.fire(item)));
        }
        this.loadFavoriteTargets();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.subscriptions.forEach(subscription => subscription.dispose());
        this._onDidChangeTreeData.dispose();
    }

    private connectionKey(connection: BspConnection): string {
        return JSON.stringify([connection.config.workspaceUri?.toString() ?? '',
            connection.config.configPath ? path.resolve(connection.config.configPath) : connection.id]);
    }

    private favoritesFor(connection: BspConnection): Set<string> {
        return this.favoriteTargets.get(this.connectionKey(connection)) ?? new Set();
    }

    private favoriteGroup(connection: BspConnection): BspTreeItem[] {
        const count = this.favoritesFor(connection).size;
        if (!count) { return []; }
        const item = new BspTreeItem(`Favorites (${count})`, vscode.TreeItemCollapsibleState.Expanded, 'favoritesGroup');
        item.id = JSON.stringify(['favorites', this.connectionKey(connection)]);
        item.connectionId = connection.id;
        return [item];
    }

    private getFavoriteTargetItems(connectionId: string): BspTreeItem[] {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection) { return []; }
        return [...this.favoritesFor(connection)].map(uri => {
            const target = connection.connected ? connection.client.targets.find(target => target.id.uri === uri) : undefined;
            if (target) { return this.buildTargetItem(connection, target, true); }
            const item = new BspTreeItem(uri.split('/').pop() || uri, vscode.TreeItemCollapsibleState.None, 'buildTarget');
            item.id = JSON.stringify(['favoriteTarget', this.connectionKey(connection), uri]);
            item.connectionId = connectionId;
            item.buildTarget = { id: { uri }, tags: [], languageIds: [], dependencies: [],
                capabilities: { canCompile: false, canRun: false, canTest: false, canDebug: false } };
            item.description = connection.connected ? 'Target unavailable' : 'Disconnected';
            item.tooltip = `${uri}\n${item.description}`;
            item.contextValue = `buildTarget favorite ${connection.connected ? 'loading' : 'disconnected'}`;
            item.iconPath = new vscode.ThemeIcon('warning');
            return item;
        });
    }

    private loadFavoriteTargets(): void {
        const state = this.context?.workspaceState.get<{
            connections: Record<string, string[]>; unassigned: string[];
        }>('bsp.favoriteTargetsByConnection');
        if (state) {
            for (const [key, targets] of Object.entries(state.connections)) {
                this.favoriteTargets.set(key, new Set(targets));
            }
            this.legacyFavorites = new Set(state.unassigned);
        } else {
            this.legacyFavorites = new Set(this.context?.workspaceState.get<string[]>('bsp.favoriteTargets')
                ?? vscode.workspace.getConfiguration('bsp').get<string[]>('favoriteTargets') ?? []);
        }
        this.migrateLegacyFavorites();
    }

    private migrateLegacyFavorites(): void {
        if (!this.legacyFavorites.size) { return; }
        const connections = this.connectionManager.getAllConnections();
        // Wait until each connection has targets before assigning old URI-only favorites.
        if (connections.some(connection => !connection.connected && connection.client.targets.length === 0)) { return; }
        let changed = false;
        for (const uri of this.legacyFavorites) {
            const matches = connections.filter(connection => connection.client.targets.some(target => target.id.uri === uri));
            if (matches.length !== 1) { continue; }
            this.addFavorite(matches[0], uri);
            this.legacyFavorites.delete(uri);
            changed = true;
        }
        if (changed) { void this.saveFavoriteTargets().catch(error => logError('Failed to save favorites', error)); }
    }

    private addFavorite(connection: BspConnection, targetId: string): void {
        const key = this.connectionKey(connection), targets = this.favoritesFor(connection);
        targets.add(targetId);
        this.favoriteTargets.set(key, targets);
    }

    private async saveFavoriteTargets(): Promise<void> {
        await this.context?.workspaceState.update('bsp.favoriteTargetsByConnection', {
            connections: Object.fromEntries([...this.favoriteTargets].map(([key, targets]) => [key, [...targets]])),
            unassigned: [...this.legacyFavorites]
        });
    }

    async addToFavorites(targetId: string, connectionId: string): Promise<void> {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection) { throw new Error('BSP connection not found'); }
        this.addFavorite(connection, targetId);
        this.legacyFavorites.delete(targetId);
        await this.saveFavoriteTargets();
        this.refresh();
    }

    async removeFromFavorites(targetId: string, connectionId: string): Promise<void> {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection) { return; }
        const key = this.connectionKey(connection), targets = this.favoritesFor(connection);
        targets.delete(targetId);
        if (targets.size === 0) { this.favoriteTargets.delete(key); }
        await this.saveFavoriteTargets();
        this.refresh();
    }

    isFavorite(targetId: string, connectionId: string): boolean {
        const connection = this.connectionManager.getConnection(connectionId);
        return !!connection && this.favoritesFor(connection).has(targetId);
    }

    getTreeItem(element: BspExplorerItem): vscode.TreeItem {
        if (element instanceof ContextTreeItem) { return this.contexts?.getTreeItem(element) ?? element; }
        const target = element.buildTarget;
        const connection = element.connectionId ? this.connectionManager.getConnection(element.connectionId) : undefined;
        if (element.type === 'connection' && connection) { return this.updateConnectionItem(element, connection); }
        if (!target || !connection?.connected) { return element; }
        const operation = connection.client.operations.get(target.id.uri);
        if (element.type === 'buildTarget' && !/loading|disconnected/.test(element.contextValue ?? '')) {
            const favorite = this.isFavorite(target.id.uri, connection.id) ? ' favorite' : '';
            element.contextValue = this.getBuildTargetContextValue(target) + favorite;
            if (connection.client.contexts?.enabled) {
                const capabilities = {
                    canCompile: connection.client.supportsOperation('compile', target),
                    canRun: connection.client.supportsOperation('run', target),
                    canTest: connection.client.supportsOperation('test', target),
                    canDebug: connection.client.supportsOperation('debug', target)
                };
                element.contextValue = this.getBuildTargetContextValue({ ...target, capabilities }) + favorite + ' supportsBuildContext'
                    + (connection.client.contexts.supportsReuse ? ' canReuseBuild' : '');
            }
            if (!connection.client.cleanCacheBlockedReason) { element.contextValue += ' canCleanCache'; }
            element.description = this.getBuildTargetDescription(target);
            if (connection.client.contexts?.enabled) { element.description = [...target.tags, ...target.languageIds].join(' · '); }
            element.iconPath = this.getBuildTargetIcon(target);
            element.tooltip = this.getBuildTargetTooltip(target, connection.config.displayName);
            if (operation) {
                element.contextValue += operation.cancelling ? ' busy cancelling' : ' busy';
                if (!operation.cancellable) { element.contextValue += ' nonCancellable'; }
                element.description = operation.description;
                element.tooltip += `\n${operation.description}`;
            }
        }
        return element;
    }

    async getChildren(element?: BspExplorerItem): Promise<BspExplorerItem[]> {
        if (element instanceof ContextTreeItem) {
            const previous = element.snapshot;
            const children = await this.contexts?.getChildren(element) ?? [];
            if (previous !== element.snapshot) { this._onDidChangeTreeData.fire(element); }
            return children;
        }
        if (!element) { return this.getConnectionItems(); }

        if (element.type === 'favoritesGroup' && element.connectionId) {
            return this.getFavoriteTargetItems(element.connectionId);
        }

        if (element.type === 'connection' && element.connectionId) {
            return this.getConnectionGroups(element.connectionId);
        }

        if ((element.type === 'targetsGroup' || element.type === 'dependencyTargetsGroup') && element.connectionId) {
            return this.getBuildTargetItems(element.connectionId, element.type === 'dependencyTargetsGroup');
        }

        if (element.type === 'buildTarget' && element.connectionId) {
            // Show target details and capabilities
            return await this.getTargetDetailItems(element);
        }

        if (element.type === 'dependencies' && element.buildTarget && element.connectionId) {
            // Expand a "Dependencies (N)" node into its individual targets
            return this.getDependencyItems(element.buildTarget, element.connectionId);
        }

        return [];
    }

    private getConnectionItems(): BspTreeItem[] {
        const connections = this.connectionManager.getAllConnections();
        
        return connections.map(connection => {
            const item = new BspTreeItem(
                connection.config.displayName || connection.config.name,
                vscode.TreeItemCollapsibleState.Expanded,
                'connection'
            );
            
            item.id = JSON.stringify(['connection', connection.id]);
            item.connectionId = connection.id;
            return this.updateConnectionItem(item, connection);
        });
    }

    private updateConnectionItem(item: BspTreeItem, connection: BspConnection): BspTreeItem {
        item.description = this.getConnectionDescription(connection);
        item.tooltip = this.getConnectionTooltip(connection);
        item.contextValue = this.getConnectionContextValue(connection);
        item.iconPath = this.getConnectionIcon(connection);
        const activity = connection.connected ? connectionActivity(connection.client) : undefined;
        if (activity) {
            item.description = activity.description;
            item.tooltip += `\n\n${activity.tooltip}`;
            item.iconPath = new vscode.ThemeIcon('loading~spin');
            item.contextValue += activity.canCancel ? ' busy canCancel' : ' busy';
        }
        return item;
    }

    private async getConnectionGroups(connectionId: string): Promise<BspExplorerItem[]> {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection || !connection.connected) {
            return [...(connection ? this.favoriteGroup(connection) : []), new BspTreeItem(
                connection?.connected === false ? 'Disconnected' : 'Not Connected',
                vscode.TreeItemCollapsibleState.None,
                'status'
            )];
        }

        try {
            // Use cached targets if available, otherwise make a request
            let targets = connection.client.targets;
            if (targets.length === 0) {
                // Only make request if cache is empty
                targets = await connection.client.getBuildTargets();
            }
            
            const dependencyCount = targets.filter(target => target.tags.includes('dependency')).length;
            const context = this.contexts?.getConnectionItem(connectionId);
            return [
                ...(context ? [context] : []),
                ...this.favoriteGroup(connection),
                this.targetGroup(connectionId, 'targetsGroup', targets.length - dependencyCount),
                this.targetGroup(connectionId, 'dependencyTargetsGroup', dependencyCount)
            ];
        } catch (error) {
            logError(`Error getting build targets for ${connection.config.displayName}`, error);
            return [...this.favoriteGroup(connection), new BspTreeItem(
                `Error: ${error}`,
                vscode.TreeItemCollapsibleState.None,
                'error'
            )];
        }
    }

    private targetGroup(connectionId: string, type: 'targetsGroup' | 'dependencyTargetsGroup', count: number): BspTreeItem {
        const dependencies = type === 'dependencyTargetsGroup';
        const item = new BspTreeItem(`${dependencies ? 'Dependencies' : 'Targets'} (${count})`,
            count === 0 ? vscode.TreeItemCollapsibleState.None
                : dependencies ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded, type);
        item.id = JSON.stringify(['targetCollection', connectionId, type]);
        item.connectionId = connectionId;
        item.contextValue = 'targetCollection';
        item.iconPath = new vscode.ThemeIcon(dependencies ? 'library' : 'target');
        return item;
    }

    private getBuildTargetItems(connectionId: string, dependencies: boolean): BspTreeItem[] {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection?.connected) { return []; }
        return connection.client.targets.filter(target => target.tags.includes('dependency') === dependencies)
            .map(target => this.buildTargetItem(connection, target));
    }

    private buildTargetItem(connection: BspConnection, target: BuildTarget, favorite = false): BspTreeItem {
        const item = new BspTreeItem(target.displayName || target.id.uri,
            vscode.TreeItemCollapsibleState.Collapsed, 'buildTarget');
        item.id = JSON.stringify([favorite ? 'favoriteTarget' : 'buildTarget', this.connectionKey(connection), target.id.uri]);
        item.connectionId = connection.id;
        item.buildTarget = target;
        item.description = this.getBuildTargetDescription(target);
        item.tooltip = this.getBuildTargetTooltip(target, connection.config.displayName);
        item.contextValue = this.getBuildTargetContextValue(target);
        if (this.isFavorite(target.id.uri, connection.id)) { item.contextValue += ' favorite'; }
        item.iconPath = this.getBuildTargetIcon(target);
        return item;
    }

    private async getTargetDetailItems(element: BspTreeItem): Promise<BspTreeItem[]> {
        if (!element.buildTarget) {
            return [];
        }

        const target = element.buildTarget;
        const children: BspTreeItem[] = [];

        // Capabilities are now shown via enabled/disabled buttons, no need to show as children

        // Add dependencies (expandable: lists the individual dependency targets)
        if (target.dependencies.length > 0) {
            const dependenciesItem = new BspTreeItem(
                `Dependencies (${target.dependencies.length})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'dependencies'
            );
            dependenciesItem.buildTarget = target;
            dependenciesItem.connectionId = element.connectionId;
            children.push(dependenciesItem);
        }

        // Add languages
        if (target.languageIds.length > 0) {
            const languagesItem = new BspTreeItem(
                `Languages: ${target.languageIds.join(', ')}`,
                vscode.TreeItemCollapsibleState.None,
                'languages'
            );
            children.push(languagesItem);
        }

        return children;
    }

    /// Children of a "Dependencies (N)" node: one leaf item per dependency target.
    /// Resolved targets still use their display names, but dependency children do
    /// not expand as build targets. That keeps cyclic target graphs from creating
    /// an endlessly expandable tree.
    private getDependencyItems(target: BuildTarget, connectionId: string): BspTreeItem[] {
        const connection = this.connectionManager.getConnection(connectionId);
        const knownTargets = connection?.client.targets ?? [];

        return target.dependencies.map(dependency => {
            const resolved = knownTargets.find(t => t.id.uri === dependency.uri);
            const label = resolved?.displayName || this.shortNameFromTargetUri(dependency.uri);

            const item = new BspTreeItem(
                label,
                vscode.TreeItemCollapsibleState.None,
                'dependency'
            );
            item.connectionId = connectionId;
            item.buildTarget = resolved;
            item.dependency = dependency;
            item.description = dependency.uri;
            item.tooltip = dependency.uri;
            item.contextValue = 'dependency';
            item.iconPath = new vscode.ThemeIcon('references');
            return item;
        });
    }

    /// Best-effort human-readable name from a build target URI
    /// (e.g. "xcode:///path/App.xcodeproj/MyLib" -> "MyLib").
    private shortNameFromTargetUri(uri: string): string {
        const trimmed = uri.replace(/\/+$/, '');
        const lastSlash = trimmed.lastIndexOf('/');
        const name = lastSlash >= 0 ? trimmed.substring(lastSlash + 1) : trimmed;
        return name.length > 0 ? name : uri;
    }

    private getConnectionDescription(connection: BspConnection): string | undefined {
        if (connection.connected) {
            return undefined;
        } else if (connection.error) {
            return '✗ Error';
        } else {
            return '○ Disconnected';
        }
    }

    private getConnectionTooltip(connection: BspConnection): string {
        const lines = [
            `BSP Server: ${connection.config.displayName || connection.config.name}`,
            `Config: ${connection.config.configPath}`,
            `Status: ${connection.connected ? 'Connected' : 'Disconnected'}`
        ];

        if (connection.lastConnected) {
            lines.push(`Last Connected: ${connection.lastConnected.toLocaleString()}`);
        }

        if (connection.error) {
            lines.push(`Error: ${connection.error}`);
        }

        return lines.join('\n');
    }

    private getConnectionContextValue(connection: BspConnection): string {
        if (connection.connected) {
            return 'connectedBspServer';
        } else {
            return 'disconnectedBspServer';
        }
    }

    private getConnectionIcon(connection: BspConnection): vscode.ThemeIcon {
        if (connection.connected) {
            return new vscode.ThemeIcon('server-environment', new vscode.ThemeColor('testing.iconPassed'));
        } else if (connection.error) {
            return new vscode.ThemeIcon('server-environment', new vscode.ThemeColor('testing.iconFailed'));
        } else {
            return new vscode.ThemeIcon('server-environment');
        }
    }

    private getBuildTargetDescription(target: BuildTarget): string {
        const parts = [];
        
        if (target.tags.length > 0) {
            parts.push(`[${target.tags.join(', ')}]`);
        }

        if (target.languageIds.length > 0) {
            parts.push(target.languageIds.join(', '));
        }

        return parts.join(' ');
    }

    private getBuildTargetTooltip(target: BuildTarget, serverName?: string): string {
        const lines = [
            `Target: ${target.displayName || target.id.uri}`,
            `URI: ${target.id.uri}`
        ];

        if (serverName) {
            lines.push(`Server: ${serverName}`);
        }

        if (target.baseDirectory) {
            lines.push(`Base Directory: ${target.baseDirectory}`);
        }

        if (target.tags.length > 0) {
            lines.push(`Tags: ${target.tags.join(', ')}`);
        }

        if (target.languageIds.length > 0) {
            lines.push(`Languages: ${target.languageIds.join(', ')}`);
        }

        const capabilities = [];
        if (target.capabilities.canCompile) capabilities.push('Compile');
        if (target.capabilities.canTest) capabilities.push('Test');
        if (target.capabilities.canRun) capabilities.push('Run');
        if (target.capabilities.canDebug) capabilities.push('Debug');
        
        if (capabilities.length > 0) {
            lines.push(`Capabilities: ${capabilities.join(', ')}`);
        }

        if (target.dependencies.length > 0) {
            lines.push(`Dependencies: ${target.dependencies.length}`);
        }

        return lines.join('\n');
    }

    private getBuildTargetContextValue(target: BuildTarget): string {
        const contextValues = ['buildTarget'];
        
        // Debug logging
        console.log(`🔍 Target capabilities for ${target.displayName || target.id.uri}:`, {
            canCompile: target.capabilities.canCompile,
            canTest: target.capabilities.canTest,
            canRun: target.capabilities.canRun,
            canDebug: target.capabilities.canDebug
        });
        
        if (target.capabilities.canCompile) {
            contextValues.push('canCompile');
        }
        
        if (target.capabilities.canTest) {
            contextValues.push('canTest');
        }
        
        if (target.capabilities.canRun) {
            contextValues.push('canRun');
        }

        if (target.capabilities.canDebug) {
            contextValues.push('canDebug');
        }

        const result = contextValues.join(' ');
        console.log(`🎯 Context value for ${target.displayName || target.id.uri}: "${result}"`);
        
        // Return combined context value with all capabilities
        return result;
    }

    private getBuildTargetIcon(target: BuildTarget): vscode.ThemeIcon {
        if (target.tags.includes('test')) {
            return new vscode.ThemeIcon('beaker');
        } else if (target.tags.includes('application')) {
            return new vscode.ThemeIcon('play');
        } else if (target.tags.includes('library')) {
            return new vscode.ThemeIcon('library');
        } else {
            return new vscode.ThemeIcon('package');
        }
    }
}

export class BspTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'connection' | 'buildTarget' | 'capability' | 'dependencies' | 'dependency' | 'languages' | 'status' | 'error' | 'favoritesGroup' | 'targetsGroup' | 'dependencyTargetsGroup'
    ) {
        super(label, collapsibleState);
        
        // Set icons and context values for different item types
        if (type === 'favoritesGroup') {
            this.iconPath = new vscode.ThemeIcon('star');
        }
    }

    public connectionId?: string;
    public buildTarget?: BuildTarget;
    public dependency?: BuildTargetIdentifier;
}
