import * as net from 'net';
import * as vscode from 'vscode';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { DapThreadRefresh } from './dapThreadRefresh';

export type DebugEndpoint = { host: string; port: number } | { socket: string };

export class BspDebugAdapter implements vscode.DebugAdapter {
    private messages = new vscode.EventEmitter<any>();
    readonly onDidSendMessage = this.messages.event;
    private connection?: net.Socket;
    private reader?: StreamMessageReader;
    private writer?: StreamMessageWriter;
    private bridge: DapThreadRefresh;
    private ended = false;
    private terminated = false;

    constructor(private endpoint: DebugEndpoint) {
        this.bridge = new DapThreadRefresh(
            message => { void this.writer!.write(message as any).catch(error => this.fail(error)); },
            message => {
                if (message.type === 'event' && message.event === 'terminated') { this.terminated = true; }
                this.messages.fire(message);
            }
        );
    }

    handleMessage(message: any): void {
        if (this.ended) { return; }
        if (!this.connection) { this.connect(); }
        if (message.type === 'request' && ['launch', 'attach'].includes(message.command) && message.arguments) {
            message = { ...message, arguments: { ...message.arguments } };
            for (const key of ['bspOwner', 'bspTarget', 'bspAttach']) { delete message.arguments[key]; }
        }
        this.bridge.fromClient(message);
    }

    dispose(): void {
        this.ended = true;
        this.bridge.dispose();
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
        this.reader?.dispose();
        this.writer?.dispose();
        this.connection?.destroy();
    }
}
