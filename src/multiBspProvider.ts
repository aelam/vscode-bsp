import * as vscode from 'vscode';
import { BspConnectionManager, BspConnection } from './bspConnectionManager';
import { BuildTarget, BuildTargetIdentifier } from './bspTypes';
import { XcodeManager } from './xcodeManager';
import { logError, logInfo } from './logger';

export class MultiBspProvider implements vscode.TreeDataProvider<BspTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BspTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private xcodeManager = new XcodeManager();
    private favoriteTargets = new Set<string>();
    private context?: vscode.ExtensionContext;
    private targetToConnectionMap = new Map<string, string>(); // targetId -> connectionId

    constructor(private connectionManager: BspConnectionManager, context?: vscode.ExtensionContext) {
        this.context = context;
        
        // Listen to connection changes
        this.connectionManager.onDidChangeConnections(() => {
            this.rebuildTargetMappings();
            this.refresh();
        });
        
        // Listen to targets updates
        this.connectionManager.onDidUpdateTargets(() => {
            this.rebuildTargetMappings();
            this.refresh();
        });
        
        // Listen to Xcode configuration changes
        this.xcodeManager.onDidChangeConfiguration(() => {
            this.refresh();
        });
        
        // Load favorite targets from configuration
        this.loadFavoriteTargets();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getXcodeManager(): XcodeManager {
        return this.xcodeManager;
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
                    const isXcode = this.xcodeManager.isXcodeTarget(target);
                    if (isXcode) {
                        this.xcodeManager.extractXcodeData(target);
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
        return element;
    }

    async getChildren(element?: BspTreeItem): Promise<BspTreeItem[]> {
        if (!element) {
            // Root level - show favorites and connections directly
            const items: BspTreeItem[] = [];
            
            // Add favorites group if there are any favorite targets
            if (this.favoriteTargets.size > 0) {
                const favoritesItem = new BspTreeItem(
                    `⭐ Favorites (${this.favoriteTargets.size})`,
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
            return this.getTargetDetailItems(element);
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
                const isXcode = this.xcodeManager.isXcodeTarget(target);
                if (isXcode) {
                    this.xcodeManager.extractXcodeData(target);
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

    private getTargetDetailItems(element: BspTreeItem): BspTreeItem[] {
        if (!element.buildTarget) {
            return [];
        }

        const target = element.buildTarget;
        const children: BspTreeItem[] = [];

        // Capabilities are now shown via enabled/disabled buttons, no need to show as children

        // Add Xcode configuration if this is an Xcode target
        if (this.xcodeManager.isXcodeTarget(target)) {
            const configDesc = this.xcodeManager.getConfigurationDescription(target.id.uri);
            if (configDesc) {
                children.push(new BspTreeItem(
                    configDesc,
                    vscode.TreeItemCollapsibleState.None,
                    'xcodeConfig'
                ));
            }
            
            // Add scheme selector
            children.push(new BspTreeItem(
                'Select Scheme...',
                vscode.TreeItemCollapsibleState.None,
                'xcodeSchemeSelector'
            ));
            
            // Add destination selector
            children.push(new BspTreeItem(
                'Select Destination...',
                vscode.TreeItemCollapsibleState.None,
                'xcodeDestinationSelector'
            ));
        }

        // Add dependencies
        if (target.dependencies.length > 0) {
            const dependenciesItem = new BspTreeItem(
                `Dependencies (${target.dependencies.length})`,
                vscode.TreeItemCollapsibleState.None,
                'dependencies'
            );
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
        
        // Add Xcode configuration if available
        if (this.xcodeManager.isXcodeTarget(target)) {
            const configDesc = this.xcodeManager.getConfigurationDescription(target.id.uri);
            if (configDesc) {
                parts.push(`[${configDesc}]`);
            } else {
                parts.push('[Xcode]');
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
        public readonly type: 'connection' | 'buildTarget' | 'capability' | 'dependencies' | 'languages' | 'status' | 'error' | 'xcodeConfig' | 'xcodeSchemeSelector' | 'xcodeDestinationSelector' | 'favoritesGroup'
    ) {
        super(label, collapsibleState);
        
        // Set icons for different item types
        if (type === 'xcodeConfig') {
            this.iconPath = new vscode.ThemeIcon('settings-gear');
        } else if (type === 'xcodeSchemeSelector') {
            this.iconPath = new vscode.ThemeIcon('list-selection');
        } else if (type === 'xcodeDestinationSelector') {
            this.iconPath = new vscode.ThemeIcon('device-mobile');
        } else if (type === 'favoritesGroup') {
            this.iconPath = new vscode.ThemeIcon('star');
        }
    }

    public connectionId?: string;
    public buildTarget?: BuildTarget;
}