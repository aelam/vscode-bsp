import { TaskProgressParams, TaskStartParams, TaskFinishParams } from './bspTypes';

export interface ProgressUpdate { message?: string; increment?: number }
type Report = (update: ProgressUpdate) => void;
interface Session { report: Report; close?: () => void; rootId?: string; percent: number }

export function taskId(value: TaskStartParams['taskId']): string {
    return typeof value === 'string' ? value : value.id;
}

// Routes standard BSP tasks, including children and tasks with no client request.
export class BspProgress {
    private origins = new Map<string, Session>();
    private tasks = new Map<string, Session>();

    register(originId: string, report: Report): void {
        this.origins.set(originId, { report, percent: 0 });
    }

    unregister(originId: string): void {
        const session = this.origins.get(originId);
        this.origins.delete(originId);
        if (session) { this.remove(session); }
    }

    start(params: TaskStartParams, background: () => { report: Report; close: () => void }): void {
        const id = taskId(params.taskId);
        if (this.tasks.has(id)) { return; }
        const parents = typeof params.taskId === 'string' ? [] : params.taskId.parents ?? [];
        let session = (params.originId ? this.origins.get(params.originId) : undefined)
            ?? parents.map(parent => this.tasks.get(parent)).find(value => value !== undefined);
        if (!session) { session = { ...background(), percent: 0 }; }
        if (!session.rootId) { session.rootId = id; }
        this.tasks.set(id, session);
        session.report({ message: params.message });
    }

    progress(params: TaskProgressParams): void {
        const id = taskId(params.taskId);
        const session = this.tasks.get(id);
        if (!session) { return; }
        let message = params.message;
        const progress = params.progress;
        const total = params.total;
        const validProgress = progress !== undefined && Number.isFinite(progress) && progress >= 0;
        const validTotal = total !== undefined && Number.isFinite(total) && total > 0;
        let increment: number | undefined;
        if (validProgress && validTotal && session.rootId === id) {
            const percent = Math.min(100, progress! / total! * 100);
            increment = Math.max(0, percent - session.percent);
            session.percent = Math.max(session.percent, percent);
        } else if (validProgress && params.unit) {
            message = `${message ?? ''} (${progress} ${params.unit})`.trim();
        }
        session.report({ message, ...(increment === undefined ? {} : { increment }) });
    }

    finish(params: TaskFinishParams): void {
        const id = taskId(params.taskId);
        const session = this.tasks.get(id);
        if (!session) { return; }
        session.report({ message: params.message });
        this.tasks.delete(id);
        if (session.rootId === id && session.close) {
            session.close();
            this.remove(session);
        }
    }

    dispose(): void {
        for (const session of new Set(this.tasks.values())) { session.close?.(); }
        this.tasks.clear();
        this.origins.clear();
    }

    private remove(session: Session): void {
        for (const [id, entry] of this.tasks) {
            if (entry === session) { this.tasks.delete(id); }
        }
    }
}
