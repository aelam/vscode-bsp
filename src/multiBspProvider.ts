import * as vscode from 'vscode';
import { BspConnectionManager, BspConnection } from './bspConnectionManager';
import { BuildTarget, BuildTargetIdentifier } from './bspTypes';
import { BuildSystemManager } from './buildSystemManager';
import { logError, logInfo } from './logger';

export class MultiBspProvider implements vscode.TreeDataProvider<BspTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BspTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private favoriteTargets = new Set<string>();
    private context?: vscode.ExtensionContext;
    private targetToConnectionMap = new Map<string, string>(); // targetId -> connectionId
    private buildSystemManager: BuildSystemManager;

    constructor(private connectionManager: BspConnectionManager, context?: vscode.ExtensionContext, sharedBuildSystemManager?: BuildSystemManager) {
        this.context = context;
        this.buildSystemManager = sharedBuildSystemManager || new BuildSystemManager(context);
        
        // Listen to connection changes
        this.connectionManager.onDidChangeConnections(() => {
            this.rebuildTargetMappings();
            this.refresh();
        });
        
        this.connectionManager.onDidChangeOperations(() => this.refresh());
        this.connectionManager.onDidChangeBackgroundTasks(() => this.refresh());

        // Listen to targets updates
        this.connectionManager.onDidUpdateTargets(() => {
            this.rebuildTargetMappings();
            this.refresh();
        });
        
        // Listen to build system configuration changes
        this.buildSystemManager.onDidChangeConfiguration(() => {
            this.refresh();
        });
        
        // Load favorite targets from configuration
        this.loadFavoriteTargets();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getBuildSystemManager(): BuildSystemManager {
        return this.buildSystemManager;
    }

    private async getFavoriteTargetItems(): Promise<BspTreeItem[]> {
        const favoriteItems: BspTreeItem[] = [];
        const processedFavorites = new Set<string>();
        
        // Process all favorite targets with known connection mappings first
        for (const favoriteId of this.favoriteTargets) {
            const connectionId = this.targetToConnectionMap.get(favoriteId);
            if (!connectionId) continue;
            
            const connection = this.connectionManager.getConnection(connectionId);
            if (!connection || !connection.connected) continue;
            
            try {
                // Use cached targets instead of making new requests
                const targets = connection.client.targets;
                const target = targets.find(t => t.id.uri === favoriteId);
                
                if (target) {
                    processedFavorites.add(favoriteId);
                    
                    // 检查是否是Xcode项目
                    const isXcode = this.buildSystemManager.canHandle(target);
                    if (isXcode) {
                        logInfo(`🔧 MultiBspProvider: Extracting Xcode data for ${target.id.uri}`);
                        const extractedData = this.buildSystemManager.extractCustomData(target);
                        logInfo(`🔧 MultiBspProvider: Extracted data for ${target.id.uri}: ${extractedData ? 'success' : 'failed'}`);
                    } else {
                        logInfo(`🔧 MultiBspProvider: Target ${target.id.uri} is not Xcode target`);
                    }
                    
                    const item = new BspTreeItem(
                        `${target.displayName || target.id.uri} (${connection.config.displayName})`,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'buildTarget'
                    );
                    
                    item.connectionId = connection.id;
                    item.buildTarget = target;
                    item.description = this.getBuildTargetDescription(target);
                    item.tooltip = this.getBuildTargetTooltip(target, connection.config.displayName);
                    item.contextValue = this.getBuildTargetContextValue(target) + ' favorite';
                    item.iconPath = this.getBuildTargetIcon(target);
                    
                    favoriteItems.push(item);
                } else {
                    // Target not found in cache, show as connected but not loaded
                    const displayName = this.extractTargetNameFromUri(favoriteId);
                    const item = new BspTreeItem(
                        `${displayName} (${connection.config.displayName})`,
                        vscode.TreeItemCollapsibleState.None,
                        'buildTarget'
                    );
                    
                    item.connectionId = connection.id;
                    item.buildTarget = {
                        id: { uri: favoriteId },
                        displayName: displayName,
                        baseDirectory: '',
                        tags: [],
                        capabilities: { canCompile: false, canTest: false, canRun: false, canDebug: false },
                        languageIds: [],
                        dependencies: []
                    };
                    item.description = '[Loading...]';
                    item.tooltip = `Target: ${displayName}\nServer: ${connection.config.displayName}\nStatus: Loading...`;
                    item.contextValue = 'buildTarget favorite loading';
                    item.iconPath = new vscode.ThemeIcon('loading~spin');
                    
                    favoriteItems.push(item);
                    processedFavorites.add(favoriteId);
                }
            } catch (error) {
                // Ignore errors for individual connections, we'll handle disconnected ones later
            }
        }
        
        // Then, show remaining favorites from disconnected servers as placeholders
        for (const favoriteId of this.favoriteTargets) {
            if (processedFavorites.has(favoriteId)) continue;
            
            // Find the connection this target belongs to (if we have mapping)
            const connectionId = this.targetToConnectionMap.get(favoriteId);
            const connection = connectionId ? this.connectionManager.getConnection(connectionId) : null;
            
            const displayName = this.extractTargetNameFromUri(favoriteId);
            const serverName = connection?.config.displayName || 'Unknown Server';
            
            const item = new BspTreeItem(
                `${displayName} (${serverName})`,
                vscode.TreeItemCollapsibleState.None,
                'buildTarget'
            );
            
            // Create placeholder target
            item.buildTarget = {
                id: { uri: favoriteId },
                displayName: displayName,
                baseDirectory: '',
                tags: [],
                capabilities: {
                    canCompile: false,
                    canTest: false,
                    canRun: false,
                    canDebug: false
                },
                languageIds: [],
                dependencies: []
            };
            
            item.connectionId = connectionId || '';
            item.description = '[Disconnected]';
            item.tooltip = `Target: ${displayName}\nServer: ${serverName}\nStatus: Disconnected`;
            item.contextValue = 'buildTarget favorite disconnected';
            item.iconPath = new vscode.ThemeIcon('warning');
            
            favoriteItems.push(item);
        }
        
        return favoriteItems;
    }

    private extractTargetNameFromUri(uri: string): string {
        // Extract a readable name from the URI
        const parts = uri.split('/');
        return parts[parts.length - 1] || uri;
    }

    private loadFavoriteTargets(): void {
        try {
            if (this.context) {
                // Use extension context storage (more reliable)
                const favorites = this.context.workspaceState.get<string[]>('bsp.favoriteTargets', []);
                this.favoriteTargets = new Set(favorites);
                logInfo(`Loaded ${favorites.length} favorite targets from extension storage`);
            } else {
                // Fallback to configuration
                const config = vscode.workspace.getConfiguration('bsp');
                const favorites = config.get<string[]>('favoriteTargets') || [];
                this.favoriteTargets = new Set(favorites);
                logInfo(`Loaded ${favorites.length} favorite targets from configuration`);
            }
        } catch (error) {
            // If loading fails, start with empty set
            logError('Failed to load favorite targets, starting with empty set', error);
            this.favoriteTargets = new Set();
        }
    }

    private rebuildTargetMappings(): void {
        // Rebuild targetToConnectionMap for all favorite targets
        const connections = this.connectionManager.getAllConnections();
        
        for (const favoriteId of this.favoriteTargets) {
            // Find the connection that contains this target
            let found = false;
            for (const connection of connections) {
                if (connection.connected && connection.client.targets.length > 0) {
                    const target = connection.client.targets.find(t => t.id.uri === favoriteId);
                    if (target) {
                        const oldConnectionId = this.targetToConnectionMap.get(favoriteId);
                        if (oldConnectionId !== connection.id) {
                            this.targetToConnectionMap.set(favoriteId, connection.id);
                            logInfo(`Updated mapping: ${favoriteId} -> ${connection.config.displayName}`);
                        }
                        found = true;
                        break;
                    }
                }
            }
            
            // If target not found in any connected server, keep existing mapping for now
            if (!found && !this.targetToConnectionMap.has(favoriteId)) {
                logInfo(`No mapping found for favorite: ${favoriteId}`);
            }
        }
    }

    private async saveFavoriteTargets(): Promise<void> {
        try {
            const favorites = Array.from(this.favoriteTargets);
            
            if (this.context) {
                // Use extension context storage (more reliable)
                await this.context.workspaceState.update('bsp.favoriteTargets', favorites);
                logInfo(`Saved ${favorites.length} favorite targets to extension storage`);
            } else {
                // Fallback to workspace configuration
                const workspaceConfig = vscode.workspace.getConfiguration();
                await workspaceConfig.update('bsp.favoriteTargets', favorites, vscode.ConfigurationTarget.Workspace);
                logInfo(`Saved ${favorites.length} favorite targets to workspace configuration`);
            }
        } catch (error) {
            logError('Failed to save favorite targets', error);
            throw error;
        }
    }

    async addToFavorites(targetId: string, connectionId?: string): Promise<void> {
        this.favoriteTargets.add(targetId);
        
        // Update targetToConnectionMap for the new favorite
        if (connectionId) {
            this.targetToConnectionMap.set(targetId, connectionId);
        } else {
            // Fallback: search in all connections
            const connections = this.connectionManager.getAllConnections();
            for (const connection of connections) {
                if (connection.connected && connection.client.targets.length > 0) {
                    const target = connection.client.targets.find(t => t.id.uri === targetId);
                    if (target) {
                        this.targetToConnectionMap.set(targetId, connection.id);
                        break;
                    }
                }
            }
        }
        
        await this.saveFavoriteTargets();
        this.refresh();
        logInfo(`Added ${targetId} to favorites`);
    }

    async removeFromFavorites(targetId: string): Promise<void> {
        this.favoriteTargets.delete(targetId);
        await this.saveFavoriteTargets();
        this.refresh();
        logInfo(`Removed ${targetId} from favorites`);
    }

    isFavorite(targetId: string): boolean {
        return this.favoriteTargets.has(targetId);
    }

    getTreeItem(element: BspTreeItem): vscode.TreeItem {
        const target = element.buildTarget;
        const connection = element.connectionId ? this.connectionManager.getConnection(element.connectionId) : undefined;
        if (!target || !connection?.connected) { return element; }
        const operation = connection.client.operations.get(target.id.uri);
        if (element.type === 'buildTarget' && !/loading|disconnected/.test(element.contextValue ?? '')) {
            const favorite = /favorite/.test(element.contextValue ?? '') ? ' favorite' : '';
            element.contextValue = this.getBuildTargetContextValue(target) + favorite;
            if (!connection.client.cleanCacheBlockedReason) { element.contextValue += ' canCleanCache'; }
            element.description = this.getBuildTargetDescription(target);
            element.iconPath = this.getBuildTargetIcon(target);
            element.tooltip = this.getBuildTargetTooltip(target, connection.config.displayName);
            if (operation) {
                element.contextValue += operation.cancelling ? ' busy cancelling' : ' busy';
                if (!operation.cancellable) { element.contextValue += ' nonCancellable'; }
                element.description = operation.message.replace(/\s+/g, ' ');
                element.iconPath = new vscode.ThemeIcon('loading~spin');
                element.tooltip += `\n${operation.message}`;
            }
        } else if (element.type === 'customSelector') {
            element.contextValue = operation ? 'dynamicSelector busy' : 'dynamicSelector';
        }
        return element;
    }

    async getChildren(element?: BspTreeItem): Promise<BspTreeItem[]> {
        if (!element) {
            // Root level - show favorites and connections directly
            const items: BspTreeItem[] = [];
            
            // Add favorites group if there are any favorite targets
            if (this.favoriteTargets.size > 0) {
                const favoritesItem = new BspTreeItem(
                    `Favorites (${this.favoriteTargets.size})`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'favoritesGroup'
                );
                items.push(favoritesItem);
            }
            
            // Add all connections directly (no extra grouping)
            const connectionItems = this.getConnectionItems();
            items.push(...connectionItems);
            
            return items;
        }

        if (element.type === 'favoritesGroup') {
            // Show favorite targets from all connections
            return this.getFavoriteTargetItems();
        }

        if (element.type === 'connection' && element.connectionId) {
            // Show build targets for a specific connection
            return this.getBuildTargetItems(element.connectionId);
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
            
            item.connectionId = connection.id;
            item.description = this.getConnectionDescription(connection);
            item.tooltip = this.getConnectionTooltip(connection);
            item.contextValue = this.getConnectionContextValue(connection);
            item.iconPath = this.getConnectionIcon(connection);
            
            return item;
        });
    }

    private async getBuildTargetItems(connectionId: string): Promise<BspTreeItem[]> {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection || !connection.connected) {
            return [new BspTreeItem(
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
            
            return targets.map(target => {
                // 检查是否是Xcode项目
                const isXcode = this.buildSystemManager.canHandle(target);
                if (isXcode) {
                    logInfo(`🔧 MultiBspProvider getChildren: Extracting Xcode data for ${target.id.uri}`);
                    const extractedData = this.buildSystemManager.extractCustomData(target);
                    logInfo(`🔧 MultiBspProvider getChildren: Extracted data for ${target.id.uri}: ${extractedData ? 'success' : 'failed'}`);
                }
                
                const item = new BspTreeItem(
                    target.displayName || target.id.uri,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'buildTarget'
                );
                
                item.connectionId = connectionId;
                item.buildTarget = target;
                item.description = this.getBuildTargetDescription(target);
                item.tooltip = this.getBuildTargetTooltip(target, connection.config.displayName);
                item.contextValue = this.getBuildTargetContextValue(target);
                item.iconPath = this.getBuildTargetIcon(target);
                
                return item;
            });
        } catch (error) {
            logError(`Error getting build targets for ${connection.config.displayName}`, error);
            return [new BspTreeItem(
                `Error: ${error}`,
                vscode.TreeItemCollapsibleState.None,
                'error'
            )];
        }
    }

    private async getTargetDetailItems(element: BspTreeItem): Promise<BspTreeItem[]> {
        if (!element.buildTarget) {
            return [];
        }

        const target = element.buildTarget;
        const children: BspTreeItem[] = [];

        // Capabilities are now shown via enabled/disabled buttons, no need to show as children

        // Add build system configuration if supported
        if (this.buildSystemManager.canHandle(target)) {
            const buildSettingsDesc = this.buildSystemManager.getBuildSettingsDescription(target);
            if (buildSettingsDesc) {
                children.push(new BspTreeItem(
                    buildSettingsDesc,
                    vscode.TreeItemCollapsibleState.None,
                    'buildConfig'
                ));
            }
            
            const manager = this.buildSystemManager.getManagerForTarget(target);
            if (manager) {
                // Get dynamic selectors from manager
                const selectors = await this.getDynamicSelectors(manager, target);
                
                for (const selector of selectors) {
                    // Choose icon based on selector key
                    let iconName = 'list-selection';
                    if (selector.keyName === 'destination' || selector.keyName === 'platform') {
                        iconName = 'device-mobile';
                    } else if (selector.keyName === 'configuration' || selector.keyName === 'buildVariant') {
                        iconName = 'tools';
                    }
                    
                    const selectorItem = new BspTreeItem(
                        selector.displayLabel,
                        vscode.TreeItemCollapsibleState.None,
                        'customSelector'
                    );
                    selectorItem.buildTarget = target;
                    selectorItem.connectionId = element.connectionId;
                    selectorItem.iconPath = new vscode.ThemeIcon(iconName);
                    selectorItem.contextValue = 'dynamicSelector';
                    
                    // Store selector configuration for later use
                    (selectorItem as any).selectorConfig = selector;
                    
                    children.push(selectorItem);
                }
            }
        }

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
            item.description = dependency.uri;
            item.tooltip = dependency.uri;
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

    private getConnectionDescription(connection: BspConnection): string {
        if (connection.connected) {
            return '✓ Connected';
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
        
        // Add build system configuration if available
        if (this.buildSystemManager.canHandle(target)) {
            const configDesc = this.buildSystemManager.getBuildSettingsDescription(target);
            if (configDesc) {
                parts.push(`[${configDesc}]`);
            } else {
                // Get manager type for generic label
                const manager = this.buildSystemManager.getManagerForTarget(target);
                if (manager) {
                    const managerType = manager.constructor.name.replace('TargetManager', '');
                    parts.push(`[${managerType}]`);
                }
            }
        }
        
        if (target.tags.length > 0) {
            parts.push(`[${target.tags.join(', ')}]`);
        }

        if (target.languageIds.length > 0) {
            parts.push(target.languageIds.join(', '));
        }

        return parts.join(' ');
    }

    private async getDynamicSelectors(manager: any, target: BuildTarget): Promise<any[]> {
        if (!manager.getDynamicSelectors) {
            return [];
        }

        try {
            const dynamicResponse = await manager.getDynamicSelectors(target.id.uri);
            return dynamicResponse?.selectors || [];
        } catch (error) {
            logError('Failed to get dynamic selectors', error);
            return [];
        }
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
        public readonly type: 'connection' | 'buildTarget' | 'capability' | 'dependencies' | 'dependency' | 'languages' | 'status' | 'error' | 'buildConfig' | 'customSelector' | 'favoritesGroup'
    ) {
        super(label, collapsibleState);
        
        // Set icons and context values for different item types
        if (type === 'buildConfig') {
            this.iconPath = new vscode.ThemeIcon('settings-gear');
        } else if (type === 'customSelector') {
            this.iconPath = new vscode.ThemeIcon('list-selection');
            this.contextValue = 'customSelector';
        } else if (type === 'favoritesGroup') {
            this.iconPath = new vscode.ThemeIcon('star');
        }
    }

    public connectionId?: string;
    public buildTarget?: BuildTarget;
}
