import * as vscode from 'vscode';
import { BspClient } from './bspClient';
import { BuildTargetProvider } from './buildTargetProvider';
import { BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory } from './debugProvider';

let bspClient: BspClient | undefined;
let buildTargetProvider: BuildTargetProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
    // 强制断点用于调试测试
    console.log('🔥 BSP ACTIVATION START - Line 10');
    console.log('BSP extension is now active');
    
    // Show activation message
    vscode.window.showInformationMessage('BSP Extension activated!');
    console.log('🔥 ACTIVATION MESSAGE SHOWN - Line 17');

    // Always register the activate command first
    const activateCommand = vscode.commands.registerCommand('bsp.activate', () => {
        initializeBspExtension(context);
    });
    context.subscriptions.push(activateCommand);

    // Check if BSP configuration exists
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        console.log('No workspace folders found');
        vscode.window.showWarningMessage('BSP: No workspace folders found. Open a folder to use BSP features.');
        return;
    }

    const bspConfigExists = await checkBspConfig(workspaceFolders[0].uri);
    if (!bspConfigExists) {
        console.log('No BSP configuration found');
        vscode.window.showInformationMessage('BSP: No .bsp configuration found. Use "BSP: Activate BSP Extension" command to force activation.');
        return;
    }

    // Auto-initialize if BSP config exists
    await initializeBspExtension(context);
}

async function initializeBspExtension(context: vscode.ExtensionContext) {
    console.log('Initializing BSP extension...');
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('BSP: No workspace folders available');
        return;
    }

    // Set context to enable BSP views
    vscode.commands.executeCommand('setContext', 'bsp.enabled', true);
    console.log('BSP context enabled');

    // Initialize BSP client
    bspClient = new BspClient(workspaceFolders[0].uri);
    buildTargetProvider = new BuildTargetProvider(bspClient);

    // Register tree data provider
    const treeView = vscode.window.createTreeView('bspTargets', {
        treeDataProvider: buildTargetProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);
    console.log('BSP tree view registered');

    // Register debug providers
    // const debugConfigProvider = new BspDebugConfigurationProvider();
    // const debugAdapterFactory = new BspDebugAdapterDescriptorFactory();
    
    // context.subscriptions.push(
    //     vscode.debug.registerDebugConfigurationProvider('bsp-debug', debugConfigProvider),
    //     vscode.debug.registerDebugAdapterDescriptorFactory('bsp-debug', debugAdapterFactory)
    // );

    // Register commands
    const refreshCommand = vscode.commands.registerCommand('bsp.refresh', () => {
        console.log('BSP refresh command triggered');
        buildTargetProvider?.refresh();
    });

    const showTargetsCommand = vscode.commands.registerCommand('bsp.showTargets', () => {
        console.log('BSP show targets command triggered');
        vscode.commands.executeCommand('bspTargets.focus');
    });

    const compileCommand = vscode.commands.registerCommand('bsp.compile', async (target) => {
        console.log('BSP compile command triggered', target);
        if (bspClient && target) {
            await bspClient.compile(target.id);
        }
    });

    const testCommand = vscode.commands.registerCommand('bsp.test', async (target) => {
        console.log('BSP test command triggered', target);
        if (bspClient && target) {
            await bspClient.test(target.id);
        }
    });

    const runCommand = vscode.commands.registerCommand('bsp.run', async (target) => {
        console.log('BSP run command triggered', target);
        if (bspClient && target) {
            await bspClient.run(target.id);
        }
    });

    const debugCommand = vscode.commands.registerCommand('bsp.debug', async (target) => {
        console.log('BSP debug command triggered', target);
        if (bspClient && target) {
            try {
                await bspClient.debug(target.id);
            } catch (error) {
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
        console.log('Attempting to connect to BSP server...');
        await bspClient.connect();
        console.log('BSP server connected, refreshing targets...');
        buildTargetProvider.refresh();
        vscode.window.showInformationMessage('BSP: Connected to server successfully!');
    } catch (error) {
        console.error('BSP connection error:', error);
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