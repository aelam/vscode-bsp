import * as vscode from 'vscode';
import * as path from 'path';
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
                    const displayName = path.basename(name, '.json');
                    
                    configs.push({
                        name: displayName,
                        configPath,
                        workspaceUri,
                        displayName: displayName.charAt(0).toUpperCase() + displayName.slice(1)
                    });
                }
            }
        } catch (error) {
            logError('Error discovering BSP configurations', error);
        }
        
        return configs;
    }

    async addConnection(config: BspConnectionConfig): Promise<string> {
        const connectionId = `${config.name}_${Date.now()}`;
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
        this._onDidChangeConnections.fire();
        
        logInfo(`Added BSP connection: ${config.displayName || config.name}`);
        return connectionId;
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