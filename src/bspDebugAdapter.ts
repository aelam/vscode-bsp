import * as net from 'net';
import * as vscode from 'vscode';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { DapThreadRefresh } from './dapThreadRefresh';

export type DebugEndpoint = { host: string; port: number } | { socket: string };

interface BspDebugAdapterOptions {
    configuration: vscode.DebugConfiguration;
    onRestart: () => void;
}

export class BspDebugAdapter implements vscode.DebugAdapter {
    private messages = new vscode.EventEmitter<any>();
    readonly onDidSendMessage = this.messages.event;
    private connection?: net.Socket;
    private reader?: StreamMessageReader;
    private writer?: StreamMessageWriter;
    private bridge: DapThreadRefresh;
    private ended = false;
    private terminated = false;

    private commands = new Map<number, string>();

    constructor(private endpoint: DebugEndpoint, private options?: BspDebugAdapterOptions) {
        this.bridge = new DapThreadRefresh(
            message => { void this.writer!.write(message as any).catch(error => this.fail(error)); },
            message => {
                if (message.type === 'response') {
                    const command = this.commands.get(message.request_seq);
                    this.commands.delete(message.request_seq);
                    if (command) { message = { ...message, command }; }
                    if (this.options && message.command === 'initialize' && message.success) {
                        message = { ...message, body: { ...message.body, supportsRestartRequest: false } };
                    }
                }
                if (this.options && message.type === 'event' && message.event === 'capabilities') {
                    message = { ...message, body: { ...message.body,
                        capabilities: { ...message.body?.capabilities, supportsRestartRequest: false } } };
                }
                if (message.type === 'event' && message.event === 'terminated') { this.terminated = true; }
                this.messages.fire(message);
            }
        );
    }

    handleMessage(message: any): void {
        if (this.ended) { return; }
        if (!this.connection) { this.connect(); }
        const originalCommand = message.command;
        if (message.type === 'request') {
            if (['launch', 'attach'].includes(message.command)) {
                const args = { ...message.arguments };
                if (this.options) {
                    // VS Code can send the previous endpoint and process ID after Restart.
                    for (const key of ['connect', 'program', 'pid', 'args', 'env', 'cwd']) { delete args[key]; }
                    Object.assign(args, this.options.configuration);
                }
                message = { ...message, command: this.options?.configuration.request ?? message.command, arguments: args };
                for (const key of ['bspOwner', 'bspTarget', 'bspAttach', 'bspRestart']) { delete args[key]; }
            } else if (this.options && ['disconnect', 'terminate'].includes(message.command)) {
                if (message.arguments?.restart) { this.options.onRestart(); }
                if (this.options.configuration.bspAttach === true) {
                    message = { ...message, command: 'disconnect', arguments: {
                        terminateDebuggee: false, suspendDebuggee: false, restart: false
                    } };
                } else if (message.arguments?.restart) {
                    message = { ...message, arguments: { ...message.arguments, restart: false,
                        ...(message.command === 'disconnect' ? { terminateDebuggee: true } : {}) } };
                }
            }
            if (message.command !== originalCommand) { this.commands.set(message.seq, originalCommand); }
        }
        this.bridge.fromClient(message);
    }

    dispose(): void {
        this.ended = true;
        this.bridge.dispose();
        this.commands.clear();
        this.reader?.dispose();
        this.writer?.dispose();
        this.connection?.destroy();
        this.messages.dispose();
    }

    private connect(): void {
        const socket = 'socket' in this.endpoint
            ? net.createConnection(this.endpoint.socket) : net.createConnection(this.endpoint);
        this.connection = socket;
        this.reader = new StreamMessageReader(socket);
        this.writer = new StreamMessageWriter(socket);
        this.reader.listen(message => this.bridge.fromBackend(message));
        this.reader.onError(error => this.fail(error));
        socket.on('error', error => this.fail(error));
        socket.on('close', () => this.fail());
    }

    private fail(error?: Error): void {
        if (this.ended) { return; }
        this.ended = true;
        if (error) {
            this.bridge.fromBackend({ type: 'event', event: 'output', body: {
                category: 'stderr', output: `BSP debug connection failed: ${error.message}\n`
            } });
        }
        if (!this.terminated) { this.bridge.fromBackend({ type: 'event', event: 'terminated' }); }
        this.bridge.dispose();
        this.commands.clear();
        this.reader?.dispose();
        this.writer?.dispose();
        this.connection?.destroy();
    }
}
