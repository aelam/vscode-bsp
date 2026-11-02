import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { BspClient } from './bspClient';
import { logError, logInfo } from './logger';

export interface BspConnectionConfig {
    name: string;
    configPath: string;
    workspaceUri: vscode.Uri;
    displayName?: string;
}

export interface BspConnection {
    id: string;
    config: BspConnectionConfig;
    client: BspClient;
    connected: boolean;
    lastConnected?: Date;
    error?: string;
}

export class BspConnectionManager {
    private connections = new Map<string, BspConnection>();
    private backgroundSubscriptions = new Map<string, vscode.Disposable>();
    private _onDidChangeBackgroundTasks = new vscode.EventEmitter<void>();
    readonly onDidChangeBackgroundTasks = this._onDidChangeBackgroundTasks.event;
    private operationSubscriptions = new Map<string, vscode.Disposable>();
    private _onDidChangeOperations = new vscode.EventEmitter<void>();
    readonly onDidChangeOperations = this._onDidChangeOperations.event;
    private _onDidChangeConnections = new vscode.EventEmitter<void>();
    readonly onDidChangeConnections = this._onDidChangeConnections.event;
    private _onDidUpdateTargets = new vscode.EventEmitter<string>(); // connectionId
    readonly onDidUpdateTargets = this._onDidUpdateTargets.event;

    constructor(private xcodeManager?: any) {}

    async discoverBspConfigurations(workspaceUri: vscode.Uri): Promise<BspConnectionConfig[]> {
        const configs: BspConnectionConfig[] = [];
        
        try {
            const bspDir = vscode.Uri.joinPath(workspaceUri, '.bsp');
            const entries = await vscode.workspace.fs.readDirectory(bspDir);
            
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const configPath = path.join(bspDir.fsPath, name);
                    let displayName = path.basename(name, '.json');
                    try {
                        const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(bspDir, name));
                        const config = JSON.parse(Buffer.from(content).toString('utf8'));
                        if (typeof config?.name === 'string' && config.name.trim()) {
                            displayName = config.name.trim();
                        }
                    } catch (error) {
                        logError(`Error reading BSP configuration: ${configPath}`, error);
                    }
                    
                    configs.push({
                        name: displayName,
                        configPath,
                        workspaceUri,
                        displayName
                    });
                }
            }
        } catch (error) {
            logError('Error discovering BSP configurations', error);
        }
        
        return configs;
    }

    async addConnection(config: BspConnectionConfig): Promise<string> {
        const connectionId = `${config.name}_${randomUUID()}`;
        const client = new BspClient(config.workspaceUri, config.configPath, () => {
            // Notify when targets are updated for this connection
            this._onDidUpdateTargets.fire(connectionId);
        }, this.xcodeManager);
        
        const connection: BspConnection = {
            id: connectionId,
            config,
            client,
            connected: false
        };
        
        this.connections.set(connectionId, connection);
        this.operationSubscriptions.set(connectionId, client.operations.onDidChange(() => this._onDidChangeOperations.fire()));
        this.backgroundSubscriptions.set(connectionId, client.backgroundTasks.onDidChange(() => this._onDidChangeBackgroundTasks.fire()));
        this.updateDisplayNames();
        this._onDidChangeConnections.fire();
        
        logInfo(`Added BSP connection: ${config.displayName || config.name}`);
        return connectionId;
    }

    private updateDisplayNames(): void {
        const connections = this.getAllConnections();
        const workspaceName = (config: BspConnectionConfig) =>
            vscode.workspace.getWorkspaceFolder(config.workspaceUri)?.name ?? path.basename(config.workspaceUri.fsPath);
        for (const connection of connections) {
            const config = connection.config;
            const matches = connections.filter(other => other.config.name === config.name);
            config.displayName = config.name;
            if (matches.length < 2) { continue; }
            let workspace = workspaceName(config);
            if (matches.some(other => workspaceName(other.config) === workspace
                && other.config.workspaceUri.toString() !== config.workspaceUri.toString())) {
                workspace = config.workspaceUri.fsPath;
            }
            const sameWorkspace = matches.filter(other =>
                other.config.workspaceUri.toString() === config.workspaceUri.toString());
            const suffix = sameWorkspace.length > 1 ? `${workspace}, ${path.basename(config.configPath)}` : workspace;
            config.displayName = `${config.name} (${suffix})`;
        }
    }

    async connectToServer(connectionId: string): Promise<void> {
        const connection = this.connections.get(connectionId);
        if (!connection) {
            throw new Error(`Connection ${connectionId} not found`);
        }

        try {
            logInfo(`Connecting to BSP server: ${connection.config.displayName}`);
            await connection.client.connect();
            
            connection.connected = true;
            connection.lastConnected = new Date();
            connection.error = undefined;
            
            this._onDidChangeConnections.fire();
            logInfo(`Successfully connected to: ${connection.config.displayName}`);
        } catch (error) {
            connection.connected = false;
            connection.error = error instanceof Error ? error.message : String(error);
            this._onDidChangeConnections.fire();
            
            logError(`Failed to connect to ${connection.config.displayName}`, error);
            throw error;
        }
    }

    async disconnectFromServer(connectionId: string): Promise<void> {
        const connection = this.connections.get(connectionId);
        if (!connection) {
            return;
        }

        try {
            if (connection.connected) {
                await connection.client.disconnect();
            }
            
            connection.connected = false;
            this._onDidChangeConnections.fire();
            
            logInfo(`Disconnected from: ${connection.config.displayName}`);
        } catch (error) {
            logError(`Error disconnecting from ${connection.config.displayName}`, error);
        }
    }

    async removeConnection(connectionId: string): Promise<void> {
        const connection = this.connections.get(connectionId);
        if (connection) {
            await this.disconnectFromServer(connectionId);
            this.connections.delete(connectionId);
            this.operationSubscriptions.get(connectionId)?.dispose();
            this.operationSubscriptions.delete(connectionId);
            this.backgroundSubscriptions.get(connectionId)?.dispose();
            this.backgroundSubscriptions.delete(connectionId);
            this.updateDisplayNames();
            this._onDidChangeConnections.fire();
            
            logInfo(`Removed BSP connection: ${connection.config.displayName}`);
        }
    }

    getConnection(connectionId: string): BspConnection | undefined {
        return this.connections.get(connectionId);
    }

    getAllConnections(): BspConnection[] {
        return Array.from(this.connections.values());
    }

    getConnectedClients(): { connectionId: string; client: BspClient; config: BspConnectionConfig }[] {
        return Array.from(this.connections.entries())
            .filter(([_, connection]) => connection.connected)
            .map(([id, connection]) => ({
                connectionId: id,
                client: connection.client,
                config: connection.config
            }));
    }

    async connectAll(): Promise<void> {
        const promises = Array.from(this.connections.keys()).map(id => 
            this.connectToServer(id).catch(error => {
                logError(`Failed to connect ${id}`, error);
            })
        );
        
        await Promise.allSettled(promises);
    }

    async disconnectAll(): Promise<void> {
        const promises = Array.from(this.connections.keys()).map(id => 
            this.disconnectFromServer(id)
        );
        
        await Promise.allSettled(promises);
    }
}