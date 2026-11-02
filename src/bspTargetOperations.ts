import { CancellationTokenSource } from 'vscode-jsonrpc/node';

export type TargetOperationKind = 'compile' | 'test' | 'run' | 'debug' | 'reload';

const labels: Record<TargetOperationKind, string> = {
    compile: 'Building', test: 'Testing', run: 'Starting app', debug: 'Starting debugger', reload: 'Reloading'
};

export class TargetBusyError extends Error {
    constructor(message: string) {
        super(`${message}. Wait for the current operation to finish or cancel it.`);
    }
}

export class TargetOperation {
    readonly cancellation = new CancellationTokenSource();
    message: string;
    cancelling = false;

    constructor(readonly kind: TargetOperationKind, private changed: () => void) {
        this.message = labels[kind];
        this.cancellation.token.onCancellationRequested(() => this.cancel());
    }

    report(message?: string): void {
        if (!message || this.cancelling || message === this.message) { return; }
        this.message = message;
        this.changed();
    }

    cancel(): void {
        if (this.cancelling) { return; }
        this.cancelling = true;
        this.message = 'Cancelling…';
        this.changed();
        this.cancellation.cancel();
    }
}

// Each client owns its operations, so equal target URIs on different servers stay independent.
export class BspTargetOperations {
    private active = new Map<string, TargetOperation>();
    private listeners = new Set<(targetId: string) => void>();

    onDidChange(listener: (targetId: string) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    get(targetId: string): TargetOperation | undefined { return this.active.get(targetId); }

    async run<T>(targetId: string, kind: TargetOperationKind, action: (operation: TargetOperation) => Promise<T>): Promise<T> {
        const current = this.active.get(targetId);
        if (current) { throw new TargetBusyError(current.message); }
        const operation = new TargetOperation(kind, () => {
            if (this.active.get(targetId) === operation) { this.changed(targetId); }
        });
        this.active.set(targetId, operation);
        this.changed(targetId);
        try { return await action(operation); }
        finally {
            operation.cancellation.dispose();
            if (this.active.get(targetId) === operation) {
                this.active.delete(targetId);
                this.changed(targetId);
            }
        }
    }

    cancel(targetId: string): void { this.active.get(targetId)?.cancel(); }

    cancelAll(): void { for (const operation of this.active.values()) { operation.cancel(); } }

    clear(): void {
        this.cancelAll();
        const targets = [...this.active.keys()];
        this.active.clear();
        for (const target of targets) { this.changed(target); }
    }

    private changed(targetId: string): void {
        for (const listener of this.listeners) { listener(targetId); }
    }
}
