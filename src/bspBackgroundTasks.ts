import type { ProgressUpdate } from './bspProgress';
import { taskId } from './bspProgress';
import { StatusCode, TaskFinishParams, TaskStartParams } from './bspTypes';

export interface BackgroundTask {
    id: string;
    title: string;
    message?: string;
    percent?: number;
    status?: StatusCode;
}

export class BspBackgroundTasks {
    private tasks = new Map<string, BackgroundTask>();
    private listeners = new Set<() => void>();
    last?: BackgroundTask;

    get active(): BackgroundTask[] { return [...this.tasks.values()]; }

    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    start(params: TaskStartParams): { report(update: ProgressUpdate): void; close(): void } {
        const task: BackgroundTask = { id: taskId(params.taskId), title: params.message || 'Background task' };
        this.tasks.set(task.id, task);
        this.last = undefined;
        this.changed();
        return {
            report: update => {
                if (this.tasks.get(task.id) !== task) { return; }
                if (update.message) { task.message = update.message; }
                if (update.increment !== undefined) { task.percent = Math.min(100, (task.percent ?? 0) + update.increment); }
                this.changed();
            },
            close: () => {
                if (this.tasks.get(task.id) !== task) { return; }
                this.tasks.delete(task.id);
                this.changed();
            }
        };
    }

    finish(params: TaskFinishParams): void {
        const task = this.tasks.get(taskId(params.taskId));
        if (!task) { return; }
        this.last = { ...task, status: params.status, message: params.message ?? task.message };
    }

    clear(): void {
        this.tasks.clear();
        this.last = undefined;
        this.changed();
    }

    private changed(): void { for (const listener of this.listeners) { listener(); } }
}
