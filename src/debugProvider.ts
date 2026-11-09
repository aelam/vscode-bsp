import * as vscode from 'vscode';
import { TargetBusyError } from './bspTargetOperations';
import { BspDebugAdapter } from './bspDebugAdapter';
import { BspDebugOptions, validateTargetOptions } from './bspTargetResolver';

type PrepareDebug = (
    folder: vscode.WorkspaceFolder | undefined,
    token: vscode.CancellationToken | undefined,
    options: BspDebugOptions
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
        if (!['launch', 'attach'].includes(config.request)) { throw new Error('BSP debugging requires launch or attach.'); }
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | null> {
        const initial = await this.resolveDebugConfiguration(folder, config, token);
        if (!initial || config.connect) { return initial; }
        const options: BspDebugOptions = { connection: config.connection, target: config.target,
            buildPolicy: config.buildPolicy, request: config.request === 'attach' ? 'attach' : 'launch' };
        validateTargetOptions(options, 'debug');
        if (config.request === 'attach' && config.pid !== undefined
            && (!Number.isInteger(config.pid) || config.pid <= 0)) {
            throw new Error('BSP Attach pid must be a positive integer.');
        }
        if (config.program !== undefined || (config.request !== 'attach' && config.pid !== undefined)) {
            throw new Error('Manual program or PID configuration requires a live connect address. Otherwise, use BSP Debug with a target.');
        }
        // VS Code runs preLaunchTask before this hook.
        const resolved = await this.prepare(folder, token, options).catch(error => {
            if (token?.isCancellationRequested) { return undefined; }
            if (!(error instanceof TargetBusyError)) { throw error; }
            void vscode.window.showInformationMessage(error.message);
            return undefined;
        });
        if (!resolved || token?.isCancellationRequested) { return null; }
        const merged: vscode.DebugConfiguration = { ...config, ...resolved, name: config.name };
        if (resolved.bspRestart) {
            // Keep user options and the selected target, without the server's endpoint or process ID.
            merged.bspRestart = { ...config, ...resolved.bspRestart, name: config.name };
        }
        if (config.request === 'attach') {
            merged.request = 'attach';
            if (config.pid !== undefined) { merged.pid = config.pid; }
        }
        // A launch configuration can override the workspace's LLDB commands.
        if (config.initCommands !== undefined) { merged.initCommands = config.initCommands; }
        delete merged.target;
        delete merged.connection;
        delete merged.buildPolicy;
        return merged;
    }

    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [
            { name: 'BSP Debug', request: 'launch', type: 'bsp-debug', stopOnEntry: true },
            { name: 'BSP Attach', request: 'attach', type: 'bsp-debug' }
        ];
    }
}

export class BspDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory, vscode.Disposable {
    private restarting = new Map<string, { configuration: vscode.DebugConfiguration; source: string }>();

    constructor(private provider?: BspDebugConfigurationProvider) {}

    async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor> {
        let configuration = session.configuration;
        const previous = this.restarting.get(session.id);
        this.restarting.delete(session.id);
        // VS Code can restart a session without running the configuration provider again.
        if (previous && previous.source === JSON.stringify(configuration.connect)) {
            if (!this.provider || !previous.configuration.bspRestart) { throw new Error('Cannot prepare a new BSP debug session.'); }
            const resolved = await this.provider.resolveDebugConfigurationWithSubstitutedVariables(
                session.workspaceFolder, { ...previous.configuration.bspRestart, name: configuration.name }
            );
            if (!resolved) { throw new Error('BSP debug restart was cancelled.'); }
            configuration = resolved;
        }
        const connect = configuration.connect;
        const options = configuration.bspRestart ? {
            configuration,
            onRestart: () => { this.restarting.set(session.id, { configuration, source: JSON.stringify(session.configuration.connect) }); }
        } : undefined;
        if (typeof connect?.socket === 'string' && connect.socket) {
            return new vscode.DebugAdapterInlineImplementation(new BspDebugAdapter({ socket: connect.socket }, options));
        }
        if (typeof connect?.host === 'string' && connect.host
            && Number.isInteger(connect.port) && connect.port > 0 && connect.port <= 65535) {
            return new vscode.DebugAdapterInlineImplementation(new BspDebugAdapter({ host: connect.host, port: connect.port }, options));
        }
        throw new Error('No valid BSP debug address. Start BSP Debug to request a new debug session.');
    }

    dispose(): void { this.restarting.clear(); }
}
