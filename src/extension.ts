import * as vscode from 'vscode';
import { BspClient } from './bspClient';
import { BuildTargetProvider } from './buildTargetProvider';
import { BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory } from './debugProvider';
import { initializeLogger, log, logError, logInfo } from './logger';

let bspClient: BspClient | undefined;
let buildTargetProvider: BuildTargetProvider | undefined;
let outputChannel: vscode.OutputChannel | undefined;

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

    // Initialize BSP client
    bspClient = new BspClient(workspaceFolders[0].uri);
    buildTargetProvider = new BuildTargetProvider(bspClient);

    // Register tree data provider
    const treeView = vscode.window.createTreeView('bspTargets', {
        treeDataProvider: buildTargetProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);
    logInfo('BSP tree view registered');

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
    });

    const showTargetsCommand = vscode.commands.registerCommand('bsp.showTargets', () => {
        logInfo('BSP show targets command triggered');
        vscode.commands.executeCommand('bspTargets.focus');
    });

    const compileCommand = vscode.commands.registerCommand('bsp.compile', async (target) => {
        logInfo(`BSP compile command triggered for target: ${target?.id || 'unknown'}`);
        if (bspClient && target) {
            await bspClient.compile(target.id);
        }
    });

    const testCommand = vscode.commands.registerCommand('bsp.test', async (target) => {
        logInfo(`BSP test command triggered for target: ${target?.id || 'unknown'}`);
        if (bspClient && target) {
            await bspClient.test(target.id);
        }
    });

    const runCommand = vscode.commands.registerCommand('bsp.run', async (target) => {
        logInfo(`BSP run command triggered for target: ${target?.id || 'unknown'}`);
        if (bspClient && target) {
            await bspClient.run(target.id);
        }
    });

    const debugCommand = vscode.commands.registerCommand('bsp.debug', async (target) => {
        logInfo(`BSP debug command triggered for target: ${target?.id || 'unknown'}`);
        if (bspClient && target) {
            try {
                await bspClient.debug(target.id);
            } catch (error) {
                logError('Debug failed', error);
                vscode.window.showErrorMessage(`Debug failed: ${error}`);
            }
        }
    });

    context.subscriptions.push(
        refreshCommand,
        showTargetsCommand,
        compileCommand,
        testCommand,
        runCommand,
        debugCommand
    );

    // Connect to BSP server
    try {
        logInfo('Attempting to connect to BSP server...');
        await bspClient.connect();
        logInfo('BSP server connected, refreshing targets...');
        buildTargetProvider.refresh();
        vscode.window.showInformationMessage('BSP: Connected to server successfully!');
    } catch (error) {
        logError('BSP connection error', error);
        vscode.window.showErrorMessage(`Failed to connect to BSP server: ${error}`);
    }
}

export function deactivate() {
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