import { BspStatusBar } from './bspStatusBar';
import { BuildContextProvider } from './buildContextProvider';
import { BspTesting } from './bspTesting';
import { sourcekitTestDiscovery } from './sourcekitTestDiscovery';
import * as vscode from 'vscode';
import { TargetBusyError } from './bspTargetOperations';
import { BspClient } from './bspClient';
import { BuildTarget, StatusCode } from './bspTypes';
import { BuildTargetProvider } from './buildTargetProvider';
import { BspConnectionManager } from './bspConnectionManager';
import { MultiBspProvider } from './multiBspProvider';
import { BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory } from './debugProvider';
import { revealBuildOutput } from './outputPaths';
import { cleanBuildCache } from './cleanCache';
import { initializeBuildLogger, initializeLogger, showBuildOutput, log, logError, logInfo } from './logger';
import * as path from 'path';

let bspClient: BspClient | undefined;
let buildTargetProvider: BuildTargetProvider | undefined;
let connectionManager: BspConnectionManager | undefined;
let multiBspProvider: MultiBspProvider | undefined;
let outputChannel: vscode.LogOutputChannel | undefined;

function reportOperationError(error: unknown): void {
    if (error instanceof TargetBusyError) {
        void vscode.window.showInformationMessage(error.message);
    } else {
        logError('Target operation failed', error);
    }
}

function getClientForSelectedTarget(selectedItem: any): BspClient | undefined {
    const client = selectedItem?.connectionId
        ? connectionManager?.getConnection(selectedItem.connectionId)?.client
        : bspClient;
    if (!client?.connected) {
        void vscode.window.showErrorMessage('BSP server not connected');
        return undefined;
    }
    return client;
}

async function compileBeforeTargetAction(client: BspClient, target: BuildTarget, actionName: string): Promise<boolean> {
    if (client.contexts.enabled || !target.capabilities.canCompile) { return true; }
    try {
        const result = await client.compile(target);
        if (result.statusCode !== StatusCode.Ok) {
            logInfo(`Skipping ${actionName} because compile did not succeed for ${target.displayName || target.id.uri}`);
            return false;
        }
        return true;
    } catch (error) {
        reportOperationError(error);
        return false;
    }
}

function updateConnectionContext(): void {
    const connected = !!bspClient?.connected
        || !!connectionManager?.getAllConnections().some(connection => connection.connected);
    void vscode.commands.executeCommand('setContext', 'bsp.connected', connected);
}

// Helper function to get or select a build target when item is not provided
async function getOrSelectBuildTarget(item?: any, include: (target: BuildTarget) => boolean = () => true): Promise<any> {
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
                    targets.filter(include).forEach(target => {
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
                const targets = (await bspClient.getBuildTargets()).filter(include);
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
            const targets = (await bspClient.getBuildTargets()).filter(include);
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

interface NavigateFolderItem {
    label?: string | vscode.TreeItemLabel;
    buildTarget?: BuildTarget;
    dependency?: { uri: string };
}

interface FolderCandidate {
    uri: vscode.Uri;
    parentsToTry: number;
    label?: string;
}

interface FolderPickItem extends vscode.QuickPickItem {
    uri: vscode.Uri;
}

function uriFromBspValue(value: string): vscode.Uri | undefined {
    const trimmed = value.trim();
    if (!trimmed) { return undefined; }

    if (path.isAbsolute(trimmed)) {
        return vscode.Uri.file(trimmed);
    }

    try {
        const uri = vscode.Uri.parse(trimmed);
        if (uri.scheme === 'file') {
            return uri;
        }
        if (uri.path.startsWith('/')) {
            return vscode.Uri.file(decodeURIComponent(uri.path));
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function projectPathFromUriPath(uriPath: string): string | undefined {
    const decodedPath = decodeURIComponent(uriPath);
    for (const extension of ['.xcodeproj', '.xcworkspace']) {
        const index = decodedPath.indexOf(extension);
        if (index >= 0) {
            return decodedPath.slice(0, index + extension.length);
        }
    }
    return undefined;
}

function getNavigateFolderCandidates(item: NavigateFolderItem): FolderCandidate[] {
    const candidates: FolderCandidate[] = [];
    const seen = new Set<string>();
    const addCandidate = (value: string | undefined, parentsToTry: number, label?: string) => {
        if (!value) { return; }
        const uri = uriFromBspValue(value);
        if (!uri || seen.has(uri.toString())) { return; }
        candidates.push({ uri, parentsToTry, label });
        seen.add(uri.toString());
    };
    const addProjectCandidates = (value: string | undefined) => {
        if (!value) { return; }
        let uriPath: string | undefined;
        try {
            const uri = vscode.Uri.parse(value.trim());
            uriPath = uri.path;
        } catch {
            uriPath = value;
        }

        const projectPath = projectPathFromUriPath(uriPath);
        if (!projectPath) { return; }
        addCandidate(path.dirname(projectPath), 0, 'Project Folder');
        addCandidate(projectPath, 0, 'Xcode Project');
    };

    addCandidate(item.buildTarget?.baseDirectory, 0);
    addProjectCandidates(item.buildTarget?.id.uri);
    addCandidate(item.buildTarget?.id.uri, 3);
    addProjectCandidates(item.dependency?.uri);
    addCandidate(item.dependency?.uri, 3);

    return candidates;
}

async function getExistingFolderUri(candidate: FolderCandidate): Promise<vscode.Uri | undefined> {
    let uri = candidate.uri;
    let parentsRemaining = candidate.parentsToTry;

    while (true) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if ((stat.type & vscode.FileType.Directory) !== 0) {
                return uri;
            }

            const parentPath = path.dirname(uri.fsPath);
            return parentPath === uri.fsPath ? uri : vscode.Uri.file(parentPath);
        } catch (error: any) {
            if (error.code !== 'FileNotFound' || parentsRemaining <= 0) {
                return undefined;
            }
        }

        const parentPath = path.dirname(uri.fsPath);
        if (parentPath === uri.fsPath) {
            return undefined;
        }

        uri = vscode.Uri.file(parentPath);
        parentsRemaining--;
    }
}

function getNavigateItemLabel(item: NavigateFolderItem): string {
    if (item.buildTarget) {
        return item.buildTarget.displayName || item.buildTarget.id.uri;
    }
    if (item.dependency) {
        return item.dependency.uri;
    }
    if (typeof item.label === 'string') {
        return item.label;
    }
    return 'selected item';
}

async function navigateToTargetFolder(item?: NavigateFolderItem): Promise<void> {
    if (!item) { return; }

    const folders: FolderPickItem[] = [];
    const seen = new Set<string>();
    for (const candidate of getNavigateFolderCandidates(item)) {
        const folderUri = await getExistingFolderUri(candidate);
        if (folderUri && !seen.has(folderUri.toString())) {
            folders.push({
                label: candidate.label ?? (path.basename(folderUri.fsPath) || folderUri.fsPath),
                description: folderUri.fsPath,
                uri: folderUri
            });
            seen.add(folderUri.toString());
        }
    }

    if (folders.length === 1) {
        await vscode.commands.executeCommand('revealInExplorer', folders[0].uri);
        return;
    }

    if (folders.length > 1) {
        const selected = await vscode.window.showQuickPick(folders, {
            placeHolder: 'Select a folder to reveal in Explorer'
        });
        if (selected) {
            await vscode.commands.executeCommand('revealInExplorer', selected.uri);
        }
        return;
    }

    vscode.window.showInformationMessage(
        `Could not find a folder for "${getNavigateItemLabel(item)}". The target did not provide a usable base directory and no existing folder could be inferred from its URI.`
    );
}

async function prepareDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    token: vscode.CancellationToken | undefined
): Promise<vscode.DebugConfiguration | undefined> {
    const connections = connectionManager?.getConnectedClients() ?? [];
    const clients = connections.filter(connection =>
        !folder || connection.config.workspaceUri.toString() === folder.uri.toString()
    ).map(connection => ({ client: connection.client, label: connection.config.displayName ?? connection.config.name }));
    if (!connections.length && bspClient?.connected
        && (!folder || folder.uri.toString() === vscode.workspace.workspaceFolders?.[0]?.uri.toString())) {
        clients.push({ client: bspClient, label: 'BSP' });
    }
    const choices: Array<vscode.QuickPickItem & { client: BspClient; target: BuildTarget }> = [];
    for (const { client, label } of clients) {
        const targets = await client.getBuildTargets();
        if (token?.isCancellationRequested) { return undefined; }
        for (const target of targets.filter(target => target.capabilities.canDebug)) {
            choices.push({ label: target.displayName ?? target.id.uri, description: label,
                detail: target.id.uri, client, target });
        }
    }
    if (!choices.length) { throw new Error('No debuggable BSP targets. Connect to a build server first.'); }
    const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(
        choices, { placeHolder: 'Select a build target to debug' }, token
    );
    if (!selected || token?.isCancellationRequested) { return undefined; }
    return selected.client.prepareDebugConfiguration(selected.target, token);
}

export async function activate(context: vscode.ExtensionContext) {
    // Create output channels
    outputChannel = vscode.window.createOutputChannel('vscode-bsp', { log: true });
    context.subscriptions.push(outputChannel);

    // Dedicated channel for build/compile output streamed from the server,
    // switchable in the Output dropdown next to 'vscode-bsp'.
    const buildOutputChannel = vscode.window.createOutputChannel('vscode-bsp-log', { log: true });
    context.subscriptions.push(buildOutputChannel);

    // Initialize loggers
    initializeLogger(outputChannel);
    initializeBuildLogger(buildOutputChannel);
    updateConnectionContext();
    
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
    
    const showBuildOutputCommand = vscode.commands.registerCommand('bsp.showBuildOutput', () => showBuildOutput());

    const showOutputCommand = vscode.commands.registerCommand('bsp.showOutput', () => {
        outputChannel?.show();
    });
    
    context.subscriptions.push(activateCommand, showOutputCommand, showBuildOutputCommand);

    // Check if BSP configuration exists
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        logError('No workspace folders found');
        vscode.window.showWarningMessage('BSP: No workspace folders found. Open a folder to use BSP features.');
        return;
    }

    const bspConfigExists = (await Promise.all(workspaceFolders.map(folder => checkBspConfig(folder.uri)))).some(Boolean);
    if (!bspConfigExists) {
        logInfo('No BSP configuration found');
        vscode.window.showInformationMessage('BSP: No .bsp configuration found. Use "BSP: Activate BSP Extension" command to force activation.');
        return;
    }

    // Auto-initialize if BSP config exists
    await initializeBspExtension(context);
}

async function initializeBspExtension(context: vscode.ExtensionContext) {
    if (connectionManager) { return; }
    logInfo('Initializing BSP extension...');
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        logError('BSP: No workspace folders available');
        vscode.window.showErrorMessage('BSP: No workspace folders available');
        return;
    }

    // Set context to enable BSP views
    vscode.commands.executeCommand('setContext', 'bsp.enabled', true);
    updateConnectionContext();
    logInfo('BSP context enabled');

    connectionManager = new BspConnectionManager(context.workspaceState);
    context.subscriptions.push(connectionManager.onDidChangeConnections(() => updateConnectionContext()));
    bspClient = new BspClient(workspaceFolders[0].uri, undefined, undefined, context.workspaceState);
    const contexts = new BuildContextProvider(connectionManager, bspClient);
    multiBspProvider = new MultiBspProvider(connectionManager, context, contexts);
    context.subscriptions.push(contexts, multiBspProvider);

    // Register multi-BSP tree data provider
    const multiBspTreeView = vscode.window.createTreeView('bspTargets', {
        treeDataProvider: multiBspProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(multiBspTreeView);
    logInfo('Multi-BSP tree view registered');

    for (const [command, action] of [
        ['bsp.configureContext', (item: any) => contexts.configure(item)],
        ['bsp.selectContextDimension', (item: any) => contexts.selectDimension(item)],
        ['bsp.executeContext', (item: any) => item ? contexts.execute(item) : contexts.configure()],
        ['bsp.contextCompile', (item: any) => contexts.execute(item, 'compile')],
        ['bsp.contextRun', (item: any) => contexts.execute(item, 'run')],
        ['bsp.contextTest', (item: any) => contexts.execute(item, 'test')],
        ['bsp.contextDebug', (item: any) => contexts.execute(item, 'debug')],
        ['bsp.contextRunWithoutBuilding', (item: any) => contexts.execute(item, 'run', 'reuse')],
        ['bsp.contextTestWithoutBuilding', (item: any) => contexts.execute(item, 'test', 'reuse')],
        ['bsp.contextDebugWithoutBuilding', (item: any) => contexts.execute(item, 'debug', 'reuse')]
    ] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(command, async item => {
            try { await action(item); }
            catch (error) { void vscode.window.showErrorMessage(`Build context: ${String(error)}`); }
        }));
    }
    context.subscriptions.push(vscode.commands.registerCommand('bsp.refreshContexts', () => contexts.refresh()));
    buildTargetProvider = new BuildTargetProvider(bspClient);
    context.subscriptions.push(new BspStatusBar(connectionManager, bspClient));
    context.subscriptions.push(new BspTesting(connectionManager, bspClient, [sourcekitTestDiscovery]));

    // F5 requests a new DAP endpoint before VS Code starts the adapter.
    const debugConfigProvider = new BspDebugConfigurationProvider(prepareDebugConfiguration);
    const debugAdapterFactory = new BspDebugAdapterDescriptorFactory();

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('bsp-debug', debugConfigProvider),
        vscode.debug.registerDebugAdapterDescriptorFactory('bsp-debug', debugAdapterFactory)
    );

    // Debug session lifecycle logging — reveals whether a session actually
    // starts, and whether/why it terminates (adapter connect failure, etc.).
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(s =>
            log(`🐛 onDidStartDebugSession: type=${s.type} name=${s.name}`)),
        vscode.debug.onDidTerminateDebugSession(s =>
            log(`🐛 onDidTerminateDebugSession: type=${s.type} name=${s.name}`)),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(e =>
            log(`🐛 debug custom event: ${e.event} ${JSON.stringify(e.body)}`))
    );

    // Register commands
    const refreshCommand = vscode.commands.registerCommand('bsp.refresh', () => {
        logInfo('BSP refresh command triggered');
        buildTargetProvider?.refresh();
        contexts.refresh();
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
        
        const configs = await connectionManager.discoverWorkspaceConfigurations(workspaceFolders.map(folder => folder.uri));
        
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
            updateConnectionContext();
            vscode.window.showInformationMessage('Connected to all BSP servers');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to connect to some BSP servers: ${error}`);
        }
    });

    const disconnectAllCommand = vscode.commands.registerCommand('bsp.disconnectAll', async () => {
        if (!connectionManager) return;
        
        await connectionManager.disconnectAll();
        updateConnectionContext();
        vscode.window.showInformationMessage('Disconnected from all BSP servers');
    });

    const connectOrDiscoverCommand = vscode.commands.registerCommand('bsp.connectOrDiscover', async () => {
        if (!connectionManager) { return; }

        let availableConnections = connectionManager.getAllConnections();
        if (availableConnections.length === 0) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) { return; }

            const configs = await connectionManager.discoverWorkspaceConfigurations(workspaceFolders.map(folder => folder.uri));
            for (const config of configs) {
                await connectionManager.addConnection(config);
            }
            availableConnections = connectionManager.getAllConnections();
        }

        if (availableConnections.length === 0) {
            vscode.window.showWarningMessage('No BSP configurations found in .bsp directory');
            return;
        }

        await connectionManager.connectAll();
        updateConnectionContext();
        const connectedCount = connectionManager.getConnectedClients().length;
        if (connectedCount > 0) {
            vscode.window.showInformationMessage(`Connected to ${connectedCount} BSP server(s)`);
        } else {
            vscode.window.showWarningMessage('No BSP servers could be connected');
        }
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
            updateConnectionContext();
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
            updateConnectionContext();
            vscode.window.showInformationMessage(`Disconnected from BSP server`);
        } catch (error) {
            logError('Failed to disconnect from server', error);
            vscode.window.showErrorMessage(`Failed to disconnect: ${error}`);
        }
    });

    const revealOutputCommand = vscode.commands.registerCommand('bsp.revealBuildOutput', async (item) => {
        const selected = await getOrSelectBuildTarget(item);
        if (!selected?.buildTarget) { return; }
        const client = selected.connectionId
            ? connectionManager?.getConnection(selected.connectionId)?.client : bspClient;
        if (!client?.connected) {
            vscode.window.showErrorMessage('BSP server not connected');
            return;
        }
        try {
            await revealBuildOutput(client, selected.buildTarget);
        } catch (error) {
            logError('Failed to reveal build output', error);
            vscode.window.showErrorMessage(`Failed to reveal build output: ${error}`);
        }
    });

    const navigateToTargetFolderCommand = vscode.commands.registerCommand('bsp.revealTargetFolder', async (item) => {
        try {
            const selected = await getOrSelectBuildTarget(item);
            if (!selected) { return; }
            await navigateToTargetFolder(selected);
        } catch (error) {
            logError('Failed to navigate to folder', error);
            void vscode.window.showErrorMessage(`Failed to navigate to folder: ${error}`);
        }
    });

    const cleanCacheCommand = vscode.commands.registerCommand('bsp.cleanCache', async item => {
        const selected = await getOrSelectBuildTarget(item);
        if (!selected?.buildTarget) { return; }
        const client = selected.connectionId
            ? connectionManager?.getConnection(selected.connectionId)?.client : bspClient;
        if (!client?.connected) {
            void vscode.window.showErrorMessage('BSP server not connected');
            return;
        }
        await cleanBuildCache(client, selected.buildTarget);
    });

    const compileCommand = vscode.commands.registerCommand('bsp.compile', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item);
        if (!selectedItem) return;

        logInfo(`BSP compile command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);
        
        if (selectedItem?.connectionId && selectedItem?.buildTarget && connectionManager) {
            const connection = connectionManager.getConnection(selectedItem.connectionId);
            if (connection?.connected) {
                await connection.client.compile(selectedItem.buildTarget).catch(reportOperationError);
            } else {
                vscode.window.showErrorMessage('BSP server not connected');
            }
        } else if (bspClient && selectedItem?.buildTarget) {
            // Fallback for backward compatibility
            await bspClient.compile(selectedItem.buildTarget).catch(reportOperationError);
        } else {
            vscode.window.showErrorMessage('No valid build target selected');
        }
    });

    const testCommand = vscode.commands.registerCommand('bsp.test', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item, target => target.capabilities.canTest);
        if (!selectedItem) return;

        logInfo(`BSP test command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);

        if (selectedItem?.buildTarget?.capabilities.canTest) {
            const client = getClientForSelectedTarget(selectedItem);
            if (!client) { return; }
            if (await compileBeforeTargetAction(client, selectedItem.buildTarget, 'test')) {
                await client.test(selectedItem.buildTarget).catch(reportOperationError);
            }
        } else {
            vscode.window.showErrorMessage('No compilable test target selected');
        }
    });

    const runCommand = vscode.commands.registerCommand('bsp.run', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item, target => target.capabilities.canRun);
        if (!selectedItem) return;

        logInfo(`BSP run command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);

        if (selectedItem?.buildTarget?.capabilities.canRun) {
            const client = getClientForSelectedTarget(selectedItem);
            if (!client) { return; }
            if (await compileBeforeTargetAction(client, selectedItem.buildTarget, 'run')) {
                await client.run(selectedItem.buildTarget).catch(reportOperationError);
            }
        } else {
            vscode.window.showErrorMessage('No runnable compile target selected');
        }
    });

    const runWithoutBuildingCommand = vscode.commands.registerCommand('bsp.runWithoutBuilding', async item => {
        const selected = await getOrSelectBuildTarget(item, target => target.capabilities.canRun);
        if (!selected?.buildTarget) { return; }
        const client = selected.connectionId
            ? connectionManager?.getConnection(selected.connectionId)?.client : bspClient;
        if (!client?.connected) {
            void vscode.window.showErrorMessage('BSP server not connected');
            return;
        }
        await client.runWithoutBuilding(selected.buildTarget).catch(reportOperationError);
    });

    const testWithoutBuildingCommand = vscode.commands.registerCommand('bsp.testWithoutBuilding', async item => {
        const selected = await getOrSelectBuildTarget(item, target => target.capabilities.canTest);
        if (!selected?.buildTarget) { return; }
        const client = selected.connectionId
            ? connectionManager?.getConnection(selected.connectionId)?.client : bspClient;
        if (!client?.connected) {
            void vscode.window.showErrorMessage('BSP server not connected');
            return;
        }
        await client.testWithoutBuilding(selected.buildTarget).catch(reportOperationError);
    });

    const debugWithoutBuildingCommand = vscode.commands.registerCommand('bsp.debugWithoutBuilding', async item => {
        const selected = await getOrSelectBuildTarget(item, target => target.capabilities.canDebug);
        if (!selected?.buildTarget) { return; }
        const client = getClientForSelectedTarget(selected);
        if (!client) { return; }
        await client.debugWithoutBuilding(selected.buildTarget).catch(reportOperationError);
    });

    const debugCommand = vscode.commands.registerCommand('bsp.debug', async (item) => {
        const selectedItem = await getOrSelectBuildTarget(item, target => target.capabilities.canDebug);
        if (!selectedItem) return;

        logInfo(`BSP debug command triggered for target: ${selectedItem?.buildTarget?.id?.uri || selectedItem?.id || 'unknown'}`);
        
        try {
            if (selectedItem?.buildTarget?.capabilities.canDebug) {
                const client = getClientForSelectedTarget(selectedItem);
                if (!client) { return; }
                if (await compileBeforeTargetAction(client, selectedItem.buildTarget, 'debug')) {
                    await client.debug(selectedItem.buildTarget).catch(reportOperationError);
                }
            } else {
                vscode.window.showErrorMessage('No debuggable compile target selected');
            }
        } catch (error) {
            logError('Debug failed', error);
            vscode.window.showErrorMessage(`Debug failed: ${error}`);
        }
    });

    const debugTestsCommand = vscode.commands.registerCommand('bsp.debugTests', async item => {
        const selected = await getOrSelectBuildTarget(item, target => target.capabilities.canTest && target.capabilities.canDebug);
        if (!selected?.buildTarget) { return; }
        const client = selected.connectionId
            ? connectionManager?.getConnection(selected.connectionId)?.client : bspClient;
        if (!client?.connected) {
            void vscode.window.showErrorMessage('BSP server not connected');
            return;
        }
        try { await client.debugTests(selected.buildTarget); }
        catch (error) {
            if (error instanceof TargetBusyError) { reportOperationError(error); }
            else { logError('Failed to debug tests', error); }
        }
    });

    const cancelOperationCommand = vscode.commands.registerCommand('bsp.cancelOperation', async item => {
        const selected = await getOrSelectBuildTarget(item);
        if (!selected?.buildTarget) { return; }
        const client = selected.connectionId
            ? connectionManager?.getConnection(selected.connectionId)?.client : bspClient;
        client?.operations.cancel(selected.buildTarget.id.uri);
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

    // Favorites management commands
    const addToFavoritesCommand = vscode.commands.registerCommand('bsp.addToFavorites', async (item) => {
        if (!multiBspProvider || !item?.buildTarget) return;
        
        await multiBspProvider.addToFavorites(item.buildTarget.id.uri, item.connectionId);
        vscode.window.showInformationMessage(`Added "${item.buildTarget.displayName || item.buildTarget.id.uri}" to favorites`);
    });

    const removeFromFavoritesCommand = vscode.commands.registerCommand('bsp.removeFromFavorites', async (item) => {
        if (!multiBspProvider || !item?.buildTarget) return;
        
        await multiBspProvider.removeFromFavorites(item.buildTarget.id.uri, item.connectionId);
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
            updateConnectionContext();
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
        connectOrDiscoverCommand,
        connectServerCommand,
        disconnectServerCommand,
        compileCommand,
        cleanCacheCommand,
        revealOutputCommand,
        navigateToTargetFolderCommand,
        testCommand,
        runCommand,
        runWithoutBuildingCommand,
        debugCommand,
        testWithoutBuildingCommand,
        debugWithoutBuildingCommand,
        debugTestsCommand,
        cancelOperationCommand,
        compileDisabledCommand,
        testDisabledCommand,
        runDisabledCommand,
        debugDisabledCommand,
        addToFavoritesCommand,
        removeFromFavoritesCommand,
        reconnectFavoriteCommand
    );

    // Auto-discover and connect to BSP servers
    try {
        logInfo('Auto-discovering BSP configurations...');
        const configs = await connectionManager.discoverWorkspaceConfigurations(workspaceFolders.map(folder => folder.uri));
        
        if (configs.length > 0) {
            logInfo(`Found ${configs.length} BSP configuration(s), adding connections...`);
            
            for (const config of configs) {
                await connectionManager.addConnection(config);
            }
            
            logInfo('Attempting to connect to all BSP servers...');
            await connectionManager.connectAll();
            updateConnectionContext();
            
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
            updateConnectionContext();
            logInfo('BSP server connected, refreshing targets...');
            buildTargetProvider.refresh();
            vscode.window.showInformationMessage('BSP: Connected to server successfully!');
        }
    } catch (error) {
        updateConnectionContext();
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
    updateConnectionContext();
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
