import type { CancellationToken } from 'vscode';
import { BuildTarget, StatusCode, TaskStartParams, TaskFinishParams, TaskProgressParams } from './bspTypes';

export interface BspOperationOptions {
    native?: boolean;
    token?: CancellationToken;
    onOutput?: (message: string) => void;
}

export interface BspTestOptions extends BspOperationOptions {
    selection?: { dataKind: string; data: unknown };
}

export type BspTestEvent =
    | { kind: 'started'; originId: string; target: BuildTarget; cancel: () => void }
    | { kind: 'finished'; originId: string; status: StatusCode; error?: string }
    | { kind: 'taskStart'; params: TaskStartParams }
    | { kind: 'taskFinish'; params: TaskFinishParams }
    | { kind: 'taskProgress'; params: TaskProgressParams }
    | { kind: 'log'; params: { message: string; originId?: string; type?: number } }
    | { kind: 'connected' | 'disconnected' | 'targets' };
