import * as net from 'net';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { DebugEndpoint } from './bspDebugAdapter';

export function debugEndpoint(uri: string): DebugEndpoint {
    const address = new URL(uri);
    if (address.protocol === 'tcp:') {
        const port = Number(address.port);
        if (address.hostname && Number.isInteger(port) && port > 0 && port <= 65535) {
            return { host: address.hostname.replace(/^\[(.*)\]$/, '$1'), port };
        }
        throw new Error(`Invalid BSP debug address: ${uri}`);
    } else if (address.protocol === 'unix:' && !address.hostname && address.pathname !== '/') {
        return { socket: decodeURIComponent(address.pathname) };
    }
    throw new Error(`Unsupported BSP debug address: ${uri}`);
}

// Release an unused endpoint without starting or stopping the application.
export async function disposeDebugEndpoint(address: string | DebugEndpoint | undefined): Promise<void> {
    let endpoint: DebugEndpoint;
    try {
        if (!address) { return; }
        endpoint = typeof address === 'string' ? debugEndpoint(address) : address;
    } catch { return; }
    await new Promise<void>(resolve => {
        let socket: net.Socket | undefined;
        let reader: StreamMessageReader | undefined;
        let writer: StreamMessageWriter | undefined;
        let finished = false;
        const finish = () => {
            if (finished) { return; }
            finished = true;
            clearTimeout(timer);
            reader?.dispose();
            writer?.dispose();
            socket?.destroy();
            resolve();
        };
        // A stopped or unreachable adapter must not hold up cancellation.
        const timer = setTimeout(finish, 1000);
        try {
            socket = 'socket' in endpoint ? net.createConnection(endpoint.socket) : net.createConnection(endpoint);
            socket.on('error', finish);
            socket.on('close', finish);
            reader = new StreamMessageReader(socket);
            writer = new StreamMessageWriter(socket);
            reader.onError(finish);
            reader.listen((message: any) => {
                if (message.type === 'response' && message.request_seq === 1) { finish(); }
            });
            socket.once('connect', () => {
                void writer!.write({ type: 'request', seq: 1, command: 'disconnect', arguments: {
                    terminateDebuggee: false, suspendDebuggee: false, restart: false
                } } as any).catch(finish);
            });
        } catch { finish(); }
    });
}
