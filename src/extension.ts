import * as vscode from 'vscode';
import { BspClient } from './bspClient';
import { BuildTargetProvider } from './buildTargetProvider';
import { BspConnectionManager } from './bspConnectionManager';
import { MultiBspProvider } from './multiBspProvider';
import { BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory } from './debugProvider';
import { BuildSystemManager } from './buildSystemManager';
import { initializeLogger, log, logError, logInfo } from './logger';

let bspClient: BspClient | undefined;
let buildTargetProvider: BuildTargetProvider | undefined;
let connectionManager: BspConnectionManager | undefined;
let multiBspProvider: MultiBspProvider | undefined;
let outputChannel: vscode.OutputChannel | undefined;

// Helper function to get or select a build target when item is not provided
async function getOrSelectBuildTarget(item?: any): Promise<any> {
    // If item is provided, return it
    if (item) {
        return item;
    }

    // No item provided, show target selection
    // First try connectionManager (multi-BSP)
    if (connectionManager) {
        const connectedClients = connectionManager.getConnectedClients();
        if (connectedClients.length > 0) {
            try {
                // Collect targets from all connected clients
                const allTargets: Array<{label: string, description: string, target: any, connectionId: string}> = [];
                
                for (const { client, connectionId } of connectedClients) {
                    const targets = await client.getBuildTargets();
                    targets.forEach(target => {
                        allTargets.push({
                            label: target.displayName || target.id.uri,
                            description: target.id.uri,
                            target: target,
                            connectionId: connectionId
                        });
                    });
                }
                
                if (allTargets.length === 0) {
                    vscode.window.showInformationMessage('No build targets available');
                    return null;
                }
                
                const selected = await vscode.window.showQuickPick(allTargets, {
                    placeHolder: 'Select a build target'
                });
                
                if (selected) {
                    // Return in the same format as item would have
                    return {
                        buildTarget: selected.target,
                        id: selected.target.id.uri,
                        connectionId: selected.connectionId
                    };
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to get build targets: ${error}`);
            }
        } else if (bspClient?.connected) {
            // Fallback to single BSP client
            try {
                const targets = await bspClient.getBuildTargets();
                if (targets.length === 0) {
                    vscode.window.showInformationMessage('No build targets available');
                    return null;
                }
                
                const targetItems = targets.map(target => ({
                    label: target.displayName || target.id.uri,
                    description: target.id.uri,
                    target: target
                }));
                
                const selected = await vscode.window.showQuickPick(targetItems, {
                    placeHolder: 'Select a build target'
                });
                
                if (selected) {
                    // Return in the same format as item would have
                    return {
                        buildTarget: selected.target,
                        id: selected.target.id.uri
                    };
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to get build targets: ${error}`);
            }
        } else {
            vscode.window.showErrorMessage('BSP server not connected');
        }
    } else if (bspClient?.connected) {
        // Fallback to single BSP client
        try {
            const targets = await bspClient.getBuildTargets();
            if (targets.length === 0) {
                vscode.window.showInformationMessage('No build targets available');
                return null;
            }
            
            const targetItems = targets.map(target => ({
                label: target.displayName || target.id.uri,
                description: target.id.uri,
                target: target
            }));
            
            const selected = await vscode.window.showQuickPick(targetItems, {
                placeHolder: 'Select a build target'
            });
            
            if (selected) {
                // Return in the same format as item would have
                return {
                    buildTarget: selected.target,
                    id: selected.target.id.uri
                };
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get build targets: ${error}`);
        }
    } else {
        vscode.window.showErrorMessage('BSP server not connected');
    }
    
    return null;
}

export async function activate(context: vscode.ExtensionContext) {
    // Create output channel
    outputChannel = vscode.window.createOutputChannel('vscode-bsp');
    context.subscriptions.push(outputChannel);
    
    // Initialize logger
    initializeLogger(outputChannel);
    
    // 强制断点用于调试测试
    log('🔥 BSP ACTIVATION START');
    log('BSP extension is now active');
    
    // Show activation message
    vscode.window.showInformationMessage('BSP Extension activated!');
    log('🔥 ACTIVATION MESSAGE SHOWN');

    // Always register the activate command first
    const activateCommand = vscode.commands.registerCommand('bsp.activate', () => {
        initializeBspExtension(context);
    });
    
    const showOutputCommand = vscode.commands.registerCommand('bsp.showOutput', () => {
        outputChannel?.show();
    });
    
    context.subscriptions.push(activateCommand, showOutputCommand);

    // Check if BSP configuration exists
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        logError('No workspace folders found');
        vscode.window.showWarningMessage('BSP: No workspace folders found. Open a folder to use BSP features.');
        return;
    }

    const bspConfigExists = await checkBspConfig(workspaceFolders[0].uri);
    if (!bspConfigExists) {
        logInfo('No BSP configuration found');
        vscode.window.showInformationMessage('BSP: No .bsp configuration found. Use "BSP: Activate BSP Extension" command to force activation.');
        return;
    }

    // Auto-initialize if BSP config exists
    await initializeBspExtension(context);
}

async function initializeBspExtension(context: vscode.ExtensionContext) {
    logInfo('Initializing BSP extension...');
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        logError('BSP: No workspace folders available');
        vscode.window.showErrorMessage('BSP: No workspace folders available');
        return;
    }

    // Set context to enable BSP views
    vscode.commands.executeCommand('setContext', 'bsp.enabled', true);
    logInfo('BSP context enabled');

    // Initialize build system manager and connection manager
    const buildSystemManager = new BuildSystemManager(context);
    
    // Create connection manager with build system manager
    const tempConnectionManager = new BspConnectionManager();
    multiBspProvider = new MultiBspProvider(tempConnectionManager, context, buildSystemManager);
    
    // Now create the real connection manager with the shared build system manager
    connectionManager = new BspConnectionManager(buildSystemManager);
    
    // Replace the multiBspProvider with the correct connection manager, reusing the build system manager
    multiBspProvider = new MultiBspProvider(connectionManager, context, buildSystemManager);

    // Register multi-BSP tree data provider
    const multiBspTreeView = vscode.window.createTreeView('bspTargets', {
        treeDataProvider: multiBspProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(multiBspTreeView);
    logInfo('Multi-BSP tree view registered');

    // Initialize single BSP client for backward compatibility
    logInfo(`🔧 Getting BuildSystemManager for BspClient: ${buildSystemManager ? 'available' : 'unavailable'}`);
    logInfo(`🔧 BuildSystemManager type: ${typeof buildSystemManager}`);
    logInfo(`🔧 BuildSystemManager instance: ${buildSystemManager?.constructor?.name}`);
    bspClient = new BspClient(workspaceFolders[0].uri, undefined, undefined, buildSystemManager);
    buildTargetProvider = new BuildTargetProvider(bspClient);

    // Register debug providers
    // const debugConfigProvider = new BspDebugConfigurationProvider();
    // const debugAdapterFactory = new BspDebugAdapterDescriptorFactory();
    
    // context.subscriptions.push(
    //     vscode.debug.registerDebugConfigurationProvider('bsp-debug', debugConfigProvider),
    //     vscode.debug.registerDebugAdapterDescriptorFactory('bsp-debug', debugAdapterFactory)
    // );

    // Register commands
    const refreshCommand = vscode.commands.registerCommand('bsp.refresh', () => {
        logInfo('BSP refresh command triggered');
        buildTargetProvider?.refresh();
        multiBspProvider?.refresh();
    });

    const reloadCommand = vscode.commands.registerCommand('bsp.reload', async (item) => {
        logInfo(`BSP reload command triggered for: ${item?.connectionId || 'global'}`);
        
        try {
            if (item?.connectionId && connectionManager) {
                // Reload specific connection
                const connection = connectionManager.getConnection(item.connectionId);
                if (connection?.connected) {
                    await connection.client.reload();
                    vscode.window.showInformationMessage('BSP workspace reloaded');
                } else {
                    vscode.window.showErrorMessage('BSP server not connected');
                }
            } else if (bspClient?.connected) {
                // Fallback to single client
                await bspClient.reload();
            } else {
                vscode.window.showErrorMessage('No BSP connection available');
            }
        } catch (error) {
            logError('Failed to reload BSP workspace', error);
            vscode.window.showErrorMessage(`Failed to reload: ${error}`);
        }
    });

    const showTargetsCommand = vscode.commands.registerCommand('bsp.showTargets', () => {
        logInfo('BSP show targets command triggered');
        vscode.commands.executeCommand('bspTargets.focus');
    });

    // Multi-BSP connection management commands
    const discoverConnectionsCommand = vscode.commands.registerCommand('bsp.discoverConnections', async () => {
        if (!connectionManager) return;
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        
        const configs = await connectionManager.discoverBspConfigurations(workspaceFolders[0].uri);
        
        for (const config of configs) {
            await connectionManager.addConnection(config);
        }
        
        if (configs.length > 0) {
            vscode.window.showInformationMessage(`Discovered ${configs.length} BSP configuration(s)`);
        } else {
            vscode.window.showWarningMessage('No BSP configurations found in .bsp directory');
        }
    });

    const connectAllCommand = vscode.commands.registerCommand('bsp.connectAll', async () => {
        if (!connectionManager) return;
        
        try {
            await connectionManager.connectAll();
            vscode.window.showInformationMessage('Connected to all BSP servers');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to connect to some BSP servers: ${error}`);
        }
    });

    const disconnectAllCommand = vscode.commands.registerCommand('bsp.disconnectAll', async () => {
        if (!connectionManager) return;
        
        await connectionManager.disconnectAll();
        vscode.window.showInformationMessage('Disconnected from all BSP servers');
    });

    const connectServerCommand = vscode.commands.registerCommand('bsp.connectServer', async (item) => {
        logInfo(`BSP connect command triggered for item: ${JSON.stringify(item)}`);
        
        if (!connectionManager) {
            logError('Connection manager not available');
            vscode.window.showErrorMessage('Connection manager not available');
            return;
        }
        
        if (!item?.connectionId) {
            logError(`No connection ID provided: ${JSON.stringify(item)}`);
            vscode.window.showErrorMessage('No connection ID provided for connect');
            return;
        }
        
        try {
            logInfo(`Connecting to server: ${item.connectionId}`);
            await connectionManager.connectToServer(item.connectionId);
            vscode.window.showInformationMessage(`Connected to BSP server`);
        } catch (error) {
            logError('Failed to connect to server', error);
            vscode.window.showErrorMessage(`Failed to connect: ${error}`);
        }
    });

    const disconnectServerCommand = vscode.commands.registerCommand('bsp.disconnectServer', async (item) => {
        logInfo(`BSP disconnect command triggered for item: ${JSON.stringify(item)}`);
        
        if (!connectionManager) {
            logError('Connection manager not available');
            vscode.window.showErrorMessage('Connection manager not available');
            return;
        }
        
        if (!item?.connectionId) {
            logError(`No connection ID provided: ${JSON.stringify(item)}`);
            vscode.window.showErrorMessage('No connection ID provided for disconnect');
            return;
        }
        
        try {
            logInfo(`Disconnecting from server: ${item.connectionId}`);
            await connectionManager.disconnectFromServer(item.connectionId);
            vscode.window.showInformationMessage(`Disconnected from BSP server`);
        } catch (error) {
            logError('Failed to disconnect from server', error);
            vscode.window.showErrorMessage(`Failed to disconnect: ${error}`);
        }
    });

    const compileCommand = vscode.commands.registerCommand('bsp.compile', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item);
        if (!selectedItem) return;

        logInfo(`BSP compile command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);
        
        if (selectedItem?.connectionId && selectedItem?.buildTarget && connectionManager) {
            const connection = connectionManager.getConnection(selectedItem.connectionId);
            if (connection?.connected) {
                await connection.client.compile(selectedItem.buildTarget);
            } else {
                vscode.window.showErrorMessage('BSP server not connected');
            }
        } else if (bspClient && selectedItem?.buildTarget) {
            // Fallback for backward compatibility
            await bspClient.compile(selectedItem.buildTarget);
        } else {
            vscode.window.showErrorMessage('No valid build target selected');
        }
    });

    const testCommand = vscode.commands.registerCommand('bsp.test', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item);
        if (!selectedItem) return;

        logInfo(`BSP test command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);
        
        if (selectedItem?.connectionId && selectedItem?.buildTarget && connectionManager) {
            const connection = connectionManager.getConnection(selectedItem.connectionId);
            if (connection?.connected) {
                await connection.client.test(selectedItem.buildTarget);
            } else {
                vscode.window.showErrorMessage('BSP server not connected');
            }
        } else if (bspClient && selectedItem?.buildTarget) {
            // Fallback for backward compatibility
            await bspClient.test(selectedItem.buildTarget);
        } else {
            vscode.window.showErrorMessage('No valid build target selected');
        }
    });

    const runCommand = vscode.commands.registerCommand('bsp.run', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item);
        if (!selectedItem) return;

        logInfo(`BSP run command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);
        
        if (selectedItem?.connectionId && selectedItem?.buildTarget && connectionManager) {
            const connection = connectionManager.getConnection(selectedItem.connectionId);
            if (connection?.connected) {
                await connection.client.run(selectedItem.buildTarget);
            } else {
                vscode.window.showErrorMessage('BSP server not connected');
            }
        } else if (bspClient && selectedItem?.buildTarget) {
            // Fallback for backward compatibility
            await bspClient.run(selectedItem.buildTarget);
        } else {
            vscode.window.showErrorMessage('No valid build target selected');
        }
    });

    const debugCommand = vscode.commands.registerCommand('bsp.debug', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item);
        if (!selectedItem) return;

        logInfo(`BSP debug command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);
        
        try {
            if (selectedItem?.connectionId && selectedItem?.buildTarget && connectionManager) {
                const connection = connectionManager.getConnection(selectedItem.connectionId);
                if (connection?.connected) {
                    await connection.client.debug(selectedItem.buildTarget);
                } else {
                    vscode.window.showErrorMessage('BSP server not connected');
                }
            } else if (bspClient && selectedItem?.buildTarget) {
                // Fallback for backward compatibility
                await bspClient.debug(selectedItem.buildTarget);
            } else {
                vscode.window.showErrorMessage('No valid build target selected');
            }
        } catch (error) {
            logError('Debug failed', error);
            vscode.window.showErrorMessage(`Debug failed: ${error}`);
        }
    });

    // Register disabled commands (these do nothing but show as disabled)
    const compileDisabledCommand = vscode.commands.registerCommand('bsp.compileDisabled', () => {
        // This command is disabled and should not be executable
    });

    const testDisabledCommand = vscode.commands.registerCommand('bsp.testDisabled', () => {
        // This command is disabled and should not be executable
    });

    const runDisabledCommand = vscode.commands.registerCommand('bsp.runDisabled', () => {
        // This command is disabled and should not be executable
    });

    const debugDisabledCommand = vscode.commands.registerCommand('bsp.debugDisabled', () => {
        // This command is disabled and should not be executable
    });

    // Build system commands
    const handleDynamicSelectorCommand = vscode.commands.registerCommand('bsp.handleDynamicSelector', async (treeItem) => {
        if (!treeItem || !treeItem.buildTarget || !treeItem.selectorConfig || !multiBspProvider) {
            logError('Invalid tree item for dynamic selector');
            return;
        }
        
        logInfo(`handleDynamicSelector command triggered for ${treeItem.selectorConfig.keyName}`);
        
        const buildSystemMgr = multiBspProvider.getBuildSystemManager();
        await buildSystemMgr.showDynamicSelector(treeItem.buildTarget, treeItem.selectorConfig);
    });

    // Favorites management commands
    const addToFavoritesCommand = vscode.commands.registerCommand('bsp.addToFavorites', async (item) => {
        if (!multiBspProvider || !item?.buildTarget) return;
        
        await multiBspProvider.addToFavorites(item.buildTarget.id.uri, item.connectionId);
        vscode.window.showInformationMessage(`Added "${item.buildTarget.displayName || item.buildTarget.id.uri}" to favorites`);
    });

    const removeFromFavoritesCommand = vscode.commands.registerCommand('bsp.removeFromFavorites', async (item) => {
        if (!multiBspProvider || !item?.buildTarget) return;
        
        await multiBspProvider.removeFromFavorites(item.buildTarget.id.uri);
        vscode.window.showInformationMessage(`Removed "${item.buildTarget.displayName || item.buildTarget.id.uri}" from favorites`);
    });

    // Reconnect command for disconnected favorite targets
    const reconnectFavoriteCommand = vscode.commands.registerCommand('bsp.reconnectFavorite', async (item) => {
        logInfo(`BSP reconnect favorite command triggered for item: ${JSON.stringify(item)}`);
        
        if (!connectionManager || !item?.connectionId) {
            vscode.window.showErrorMessage('Connection information not available');
            return;
        }
        
        try {
            logInfo(`Reconnecting to server: ${item.connectionId}`);
            await connectionManager.connectToServer(item.connectionId);
            vscode.window.showInformationMessage(`Reconnected to BSP server for favorite target`);
        } catch (error) {
            logError('Failed to reconnect to server', error);
            vscode.window.showErrorMessage(`Failed to reconnect: ${error}`);
        }
    });

    context.subscriptions.push(
        refreshCommand,
        reloadCommand,
        showTargetsCommand,
        discoverConnectionsCommand,
        connectAllCommand,
        disconnectAllCommand,
        connectServerCommand,
        disconnectServerCommand,
        compileCommand,
        testCommand,
        runCommand,
        debugCommand,
        compileDisabledCommand,
        testDisabledCommand,
        runDisabledCommand,
        debugDisabledCommand,
        handleDynamicSelectorCommand,
        addToFavoritesCommand,
        removeFromFavoritesCommand,
        reconnectFavoriteCommand
    );

    // Auto-discover and connect to BSP servers
    try {
        logInfo('Auto-discovering BSP configurations...');
        const configs = await connectionManager.discoverBspConfigurations(workspaceFolders[0].uri);
        
        if (configs.length > 0) {
            logInfo(`Found ${configs.length} BSP configuration(s), adding connections...`);
            
            for (const config of configs) {
                await connectionManager.addConnection(config);
            }
            
            logInfo('Attempting to connect to all BSP servers...');
            await connectionManager.connectAll();
            
            const connectedClients = connectionManager.getConnectedClients();
            if (connectedClients.length > 0) {
                vscode.window.showInformationMessage(`Connected to ${connectedClients.length} BSP server(s)!`);
            } else {
                vscode.window.showWarningMessage('No BSP servers could be connected');
            }
        } else {
            // Fallback to single BSP client for backward compatibility
            logInfo('No multi-BSP configs found, trying single BSP connection...');
            await bspClient.connect();
            logInfo('BSP server connected, refreshing targets...');
            buildTargetProvider.refresh();
            vscode.window.showInformationMessage('BSP: Connected to server successfully!');
        }
    } catch (error) {
        logError('BSP connection error', error);
        vscode.window.showErrorMessage(`Failed to connect to BSP server: ${error}`);
    }
}

export function deactivate() {
    if (connectionManager) {
        connectionManager.disconnectAll();
    }
    if (bspClient) {
        bspClient.disconnect();
    }
}

async function checkBspConfig(workspaceUri: vscode.Uri): Promise<boolean> {
    try {
        const bspDir = vscode.Uri.joinPath(workspaceUri, '.bsp');
        const stat = await vscode.workspace.fs.stat(bspDir);
        return stat.type === vscode.FileType.Directory;
    } catch {
        return false;
    }
}