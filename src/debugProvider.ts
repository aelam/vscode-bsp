import * as vscode from 'vscode';

type PrepareDebug = (
    folder: vscode.WorkspaceFolder | undefined,
    token: vscode.CancellationToken | undefined
) => Promise<vscode.DebugConfiguration | undefined>;

export class BspDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    constructor(private prepare: PrepareDebug) {}

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | null> {
        if (token?.isCancellationRequested) { return null; }
        if (!config.type) { config.type = 'bsp-debug'; }
        if (!config.request) { config.request = 'launch'; }
        if (!config.name) { config.name = 'BSP Debug'; }
        // Configurations from the target toolbar already contain a DAP endpoint.
        if (config.connect) { return config; }
        if (config.request === 'attach') {
            throw new Error('BSP Attach needs a live DAP address. Use BSP Debug to request one from the build server.');
        }
        const resolved = await this.prepare(folder, token);
        if (!resolved || token?.isCancellationRequested) { return null; }
        return { ...config, ...resolved, name: config.name };
    }

    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [{ name: 'BSP Debug', request: 'launch', type: 'bsp-debug', stopOnEntry: true }];
    }
}

export class BspDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
        const connect = session.configuration.connect;
        if (typeof connect?.socket === 'string' && connect.socket) {
            return new vscode.DebugAdapterNamedPipeServer(connect.socket);
        }
        if (typeof connect?.host === 'string' && connect.host
            && Number.isInteger(connect.port) && connect.port > 0 && connect.port <= 65535) {
            return new vscode.DebugAdapterServer(connect.port, connect.host);
        }
        throw new Error('No valid BSP debug address. Start BSP Debug to request a new debug session.');
    }
}
