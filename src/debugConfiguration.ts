import type * as vscode from 'vscode';
import type { DebugSessionAddressResult } from './bspTypes';
import { debugEndpoint } from './debugEndpoint';

export function debugConfiguration(result: DebugSessionAddressResult, name: string, request: 'launch' | 'attach' = 'launch'): vscode.DebugConfiguration {
    const connect = debugEndpoint(result.uri);
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
