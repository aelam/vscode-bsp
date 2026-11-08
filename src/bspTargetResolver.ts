import * as path from 'path';
import { CancellationToken } from 'vscode-jsonrpc/node';
import * as vscode from 'vscode';
import type { BspClient } from './bspClient';
import type { BspConnection, BspConnectionManager } from './bspConnectionManager';
import type { ContextBuildPolicy, ContextOperation } from './buildContext';
import { BuildTarget, StatusCode } from './bspTypes';

export interface BspTargetOptions {
    connection?: string;
    target?: string;
    buildPolicy?: ContextBuildPolicy;
}

export interface BspDebugOptions extends BspTargetOptions {
    request?: 'launch' | 'attach';
}

export interface BspTargetChoice extends vscode.QuickPickItem {
    connection: BspConnection;
    target: BuildTarget;
}

export function validateTargetOptions(options: BspTargetOptions, operation: ContextOperation): ContextBuildPolicy {
    for (const key of ['connection', 'target'] as const) {
        const value = options[key];
        if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
            throw new Error(`BSP ${key} must be a nonempty string.`);
        }
    }
    const policy = options.buildPolicy ?? 'build';
    if (options.buildPolicy === null || !['build', 'reuse'].includes(policy)) {
        throw new Error('BSP buildPolicy must be build or reuse.');
    }
    if (operation === 'compile' && policy !== 'build') { throw new Error('Compile requires buildPolicy: build.'); }
    return policy;
}

export class BspTargetResolver {
    private connecting = new Map<string, Promise<void>>();

    constructor(
        private manager: BspConnectionManager,
        private legacy?: BspClient,
        private legacyFolder?: vscode.WorkspaceFolder
    ) {}

    private connections(folder?: vscode.WorkspaceFolder): BspConnection[] {
        const connections = this.manager.getAllConnections().filter(connection =>
            !folder || connection.config.workspaceUri.toString() === folder.uri.toString());
        if (!connections.length && this.legacy?.connected && this.legacyFolder
            && (!folder || folder.uri.toString() === this.legacyFolder.uri.toString())) {
            connections.push({ id: 'legacy', client: this.legacy, connected: true,
                config: { name: 'BSP', workspaceUri: this.legacyFolder.uri, configPath: '' } });
        }
        return connections;
    }

    async list(folder?: vscode.WorkspaceFolder, token?: vscode.CancellationToken): Promise<BspTargetChoice[]> {
        return this.choices(this.connections(folder).filter(connection => connection.client.connected), token);
    }

    private async choices(connections: BspConnection[], token?: vscode.CancellationToken): Promise<BspTargetChoice[]> {
        const choices: BspTargetChoice[] = [];
        for (const connection of connections) {
            if (token?.isCancellationRequested) { return []; }
            const targets = await connection.client.getBuildTargets(token);
            if (token?.isCancellationRequested) { return []; }
            for (const target of targets) {
                choices.push({ label: target.displayName ?? target.id.uri,
                    description: connection.config.displayName ?? connection.config.name,
                    detail: `${connection.config.configPath} · ${target.id.uri}`, connection, target });
            }
        }
        return choices;
    }

    supports(choice: BspTargetChoice, operation: ContextOperation): boolean {
        const client = choice.connection.client;
        return client.supportsOperation(operation, choice.target)
            && (!client.contexts.enabled || client.contexts.operations.includes(operation));
    }

    async prepareDebug(
        options: BspDebugOptions, folder?: vscode.WorkspaceFolder, token = CancellationToken.None
    ): Promise<vscode.DebugConfiguration | undefined> {
        const request = options.request ?? 'launch';
        const attaching = request === 'attach';
        const mode = attaching ? 'Attach' : 'Debug';
        const policy = validateTargetOptions(options, 'debug');
        const selectionOptions = attaching ? { ...options, buildPolicy: undefined } : options;
        const effectivePolicy = (client: BspClient): ContextBuildPolicy =>
            attaching ? (client.contexts.supportsReuse ? 'reuse' : 'build') : policy;
        let selected: BspTargetChoice | undefined;
        if (options.target) {
            selected = await this.resolve(selectionOptions, 'debug', folder, token);
        } else {
            const connection = await this.chooseConnection(selectionOptions, folder, token, mode);
            if (!connection) { return undefined; }
            const { client } = connection;
            if (!attaching && policy === 'reuse' && !client.contexts.supportsReuse) {
                throw new Error('This BSP server does not support buildPolicy: reuse.');
            }
            if (client.contexts.enabled && Object.keys(client.contexts.getSelection({})).length) {
                if (client.prepareExecutionContext && !await client.prepareExecutionContext({}, 'debug', token)) { return undefined; }
                if (token.isCancellationRequested) { return undefined; }
                const resolved = await client.contexts.resolve({}, 'debug', token, effectivePolicy(client));
                if (token.isCancellationRequested) { return undefined; }
                return client.prepareResolvedDebugConfiguration(resolved, token, request);
            }
            selected = await this.pickTarget(connection, mode, token, choice => this.supports(choice, 'debug'));
        }
        if (!selected || token.isCancellationRequested) { return undefined; }
        const client = selected.connection.client, target = selected.target;
        if (!attaching && !client.contexts.enabled && client.supportsOperation('compile', target)) {
            const result = await client.compile(target, token);
            if (token.isCancellationRequested || result.statusCode === StatusCode.Cancelled) { return undefined; }
            if (result.statusCode !== StatusCode.Ok) { throw new Error('Build failed. The debugger was not started.'); }
        }
        if (token.isCancellationRequested) { return undefined; }
        return client.prepareDebugConfiguration(target, token, effectivePolicy(client), request);
    }

    private async chooseConnection(
        options: BspTargetOptions, folder: vscode.WorkspaceFolder | undefined,
        token: vscode.CancellationToken, mode: 'Debug' | 'Attach'
    ): Promise<BspConnection | undefined> {
        if (token.isCancellationRequested) { return undefined; }
        let connections = this.scopedConnections(options, folder);
        if (!options.connection) {
            connections = connections.filter(entry => !entry.client.connected || entry.client.supportsOperation('debug'));
        }
        if (!connections.length) { throw new Error(`No BSP connection supports ${mode}. Update the server and reconnect.`); }
        const connection = connections.length === 1 ? connections[0] : (await vscode.window.showQuickPick(
            connections.map(entry => ({ label: entry.config.displayName ?? entry.config.name,
                description: entry.client.connected ? undefined : 'Disconnected', detail: entry.config.configPath, connection: entry })),
            { placeHolder: `Select a BSP connection for ${mode}` }, token
        ))?.connection;
        if (!connection || token.isCancellationRequested) { return undefined; }
        await this.connect(connection);
        return token.isCancellationRequested ? undefined : connection;
    }

    private async pickTarget(
        connection: BspConnection, mode: string, token: vscode.CancellationToken,
        accepts: (choice: BspTargetChoice) => boolean
    ): Promise<BspTargetChoice | undefined> {
        const choices = (await this.choices([connection], token)).filter(accepts);
        if (token.isCancellationRequested) { return undefined; }
        if (!choices.length) { throw new Error(`No BSP targets support ${mode}.`); }
        const selected = await vscode.window.showQuickPick(choices,
            { placeHolder: `Select a build target for ${mode}` }, token);
        return token.isCancellationRequested ? undefined : selected;
    }

    private scopedConnections(options: BspTargetOptions, folder?: vscode.WorkspaceFolder): BspConnection[] {
        let connections = this.connections(folder);
        if (options.connection) {
            connections = connections.filter(connection => connection.config.configPath
                && path.resolve(connection.config.configPath) === path.resolve(connection.config.workspaceUri.fsPath, options.connection!));
            if (connections.length !== 1) {
                throw new Error('BSP connection was not found or is ambiguous. Use a .bsp JSON path in the task or launch workspace.');
            }
        }
        return connections;
    }

    private async connect(connection: BspConnection): Promise<void> {
        if (connection.client.connected) { return; }
        let pending = this.connecting.get(connection.id);
        if (!pending) {
            pending = this.manager.connectToServer(connection.id).finally(() => this.connecting.delete(connection.id));
            this.connecting.set(connection.id, pending);
        }
        await pending;
    }

    async resolve(
        options: BspTargetOptions, operation: ContextOperation, folder?: vscode.WorkspaceFolder,
        token?: vscode.CancellationToken, prompt = false
    ): Promise<BspTargetChoice | undefined> {
        const policy = validateTargetOptions(options, operation);
        if (token?.isCancellationRequested) { return undefined; }
        let connections = this.scopedConnections(options, folder);
        if (connections.length === 1) { await this.connect(connections[0]); }
        connections = connections.filter(connection => connection.client.connected);
        if (token?.isCancellationRequested) { return undefined; }
        if (!connections.length) { throw new Error('No connected BSP server. Connect a server or specify its connection file.'); }
        let choices = await this.choices(connections, token);
        if (token?.isCancellationRequested) { return undefined; }
        if (options.target) {
            const exact = choices.filter(choice => choice.target.id.uri === options.target);
            choices = exact.length ? exact : choices.filter(choice => choice.target.displayName === options.target);
            if (choices.length !== 1) {
                throw new Error(`BSP target "${options.target}" was not found or is ambiguous. Specify its exact URI and connection file.`);
            }
            if (!this.supports(choices[0], operation)) { throw new Error(`This BSP target does not support ${operation}.`); }
        } else {
            if (!prompt) { throw new Error('A BSP task requires a target URI or unique display name.'); }
            choices = choices.filter(choice => this.supports(choice, operation));
        }
        if (!choices.length) { throw new Error(`No BSP targets support ${operation}.`); }
        const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(
            choices, { placeHolder: `Select a build target to ${operation}` }, token
        );
        if (!selected || token?.isCancellationRequested) { return undefined; }
        if (policy === 'reuse' && !selected.connection.client.contexts.supportsReuse) {
            throw new Error('This BSP server does not support buildPolicy: reuse.');
        }
        return selected;
    }
}
