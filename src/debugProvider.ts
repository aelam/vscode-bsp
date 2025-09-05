import * as vscode from 'vscode';

export class BspDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    
    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined, 
        config: vscode.DebugConfiguration, 
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        
        // If launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'scala' || editor?.document.languageId === 'java') {
                config.type = 'bsp-debug';
                config.name = 'BSP Debug';
                config.request = 'launch';
                config.stopOnEntry = true;
            }
        }

        if (!config.program) {
            return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
                return undefined;	// abort launch
            });
        }

        return config;
    }

    /**
     * Provide initial debug configurations
     */
    provideDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined, 
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        
        return [
            {
                name: 'BSP Debug',
                request: 'launch',
                type: 'bsp-debug',
                stopOnEntry: true
            },
            {
                name: 'BSP Attach',
                request: 'attach',
                type: 'bsp-debug',
                connect: {
                    host: 'localhost',
                    port: 5005
                }
            }
        ];
    }
}

export class BspDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    
    createDebugAdapterDescriptor(
        session: vscode.DebugSession, 
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        
        const config = session.configuration;
        
        if (config.connect) {
            if (config.connect.host && config.connect.port) {
                // Connect via TCP
                return new vscode.DebugAdapterServer(config.connect.port, config.connect.host);
            } else if (config.connect.socket) {
                // Connect via Unix socket
                return new vscode.DebugAdapterNamedPipeServer(config.connect.socket);
            }
        }
        
        // Default: return undefined to use the default adapter
        return undefined;
    }
}
