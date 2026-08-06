import * as vscode from 'vscode';

export class BspDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    
    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // Configurations are normally supplied programmatically by the BSP
        // client (from the server's debugSession/start response), carrying a
        // `connect` endpoint plus either `pid` (attach) or `program` (launch).
        // Only fill in essentials; do NOT require `program` — attach uses `pid`.
        if (!config.type) { config.type = 'bsp-debug'; }
        if (!config.request) { config.request = 'attach'; }
        if (!config.name) { config.name = 'BSP Debug'; }
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
