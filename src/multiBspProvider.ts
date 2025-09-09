import * as vscode from 'vscode';
import { BspConnectionManager, BspConnection } from './bspConnectionManager';
import { BuildTarget, BuildTargetIdentifier } from './bspTypes';
import { log, logError, logInfo } from './logger';

export class MultiBspProvider implements vscode.TreeDataProvider<BspTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BspTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private connectionManager: BspConnectionManager) {
        // Listen to connection changes
        this.connectionManager.onDidChangeConnections(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BspTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BspTreeItem): Promise<BspTreeItem[]> {
        if (!element) {
            // Root level - show all connections
            return this.getConnectionItems();
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
            const targets = await connection.client.getBuildTargets();
            return targets.map(target => {
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

        // Add capabilities
        if (target.capabilities.canCompile) {
            children.push(new BspTreeItem('Can Compile', vscode.TreeItemCollapsibleState.None, 'capability'));
        }
        if (target.capabilities.canTest) {
            children.push(new BspTreeItem('Can Test', vscode.TreeItemCollapsibleState.None, 'capability'));
        }
        if (target.capabilities.canRun) {
            children.push(new BspTreeItem('Can Run', vscode.TreeItemCollapsibleState.None, 'capability'));
        }
        if (target.capabilities.canDebug) {
            children.push(new BspTreeItem('Can Debug', vscode.TreeItemCollapsibleState.None, 'capability'));
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
        public readonly type: 'connection' | 'buildTarget' | 'capability' | 'dependencies' | 'languages' | 'status' | 'error'
    ) {
        super(label, collapsibleState);
    }

    public connectionId?: string;
    public buildTarget?: BuildTarget;
}