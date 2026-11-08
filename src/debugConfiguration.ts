import type * as vscode from 'vscode';
import type { DebugSessionAddressResult } from './bspTypes';

export function debugConfiguration(result: DebugSessionAddressResult, name: string, request: 'launch' | 'attach' = 'launch'): vscode.DebugConfiguration {
    const address = new URL(result.uri);
    let connect: { host: string; port: number } | { socket: string };
    if (address.protocol === 'tcp:') {
        const port = Number(address.port);
        if (!address.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid BSP debug address: ${result.uri}`);
        }
        connect = { host: address.hostname.replace(/^\[(.*)\]$/, '$1'), port };
    } else if (address.protocol === 'unix:' && !address.hostname && address.pathname !== '/') {
        connect = { socket: decodeURIComponent(address.pathname) };
    } else {
        throw new Error(`Unsupported BSP debug address: ${result.uri}`);
    }
    const config: vscode.DebugConfiguration = {
        type: 'bsp-debug', name, request: request === 'attach' ? 'attach' : result.data?.request ?? request, connect
    };
    if (result.data?.pid !== undefined) { config.pid = result.data.pid; }
    if (result.data?.program !== undefined) { config.program = result.data.program; }
    if (result.data?.args !== undefined) { config.args = [...result.data.args]; }
    if (result.data?.env !== undefined) { config.env = { ...result.data.env }; }
    if (result.data?.cwd !== undefined) { config.cwd = result.data.cwd; }
    return config;
}
