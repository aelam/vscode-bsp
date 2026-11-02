import type { CancellationToken } from 'vscode';
import { BuildTarget, StatusCode, TaskStartParams, TaskFinishParams, TaskProgressParams } from './bspTypes';

export interface BspTestOptions {
    native?: boolean;
    selection?: { dataKind: string; data: unknown };
    token?: CancellationToken;
}

export type BspTestEvent =
    | { kind: 'started'; originId: string; target: BuildTarget; cancel: () => void }
    | { kind: 'finished'; originId: string; status: StatusCode; error?: string }
    | { kind: 'taskStart'; params: TaskStartParams }
    | { kind: 'taskFinish'; params: TaskFinishParams }
    | { kind: 'taskProgress'; params: TaskProgressParams }
    | { kind: 'log'; params: { message: string; originId?: string; type?: number } }
    | { kind: 'connected' | 'disconnected' | 'targets' };
