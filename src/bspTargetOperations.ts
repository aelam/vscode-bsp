import { CancellationTokenSource } from 'vscode-jsonrpc/node';

export type TargetOperationKind = 'compile' | 'test' | 'run' | 'debug' | 'reload' | 'clean';

const labels: Record<TargetOperationKind, string> = {
    compile: 'Building', test: 'Testing', run: 'Starting app', debug: 'Starting debugger', reload: 'Reloading',
    clean: 'Cleaning build cache'
};

export class TargetBusyError extends Error {
    constructor(message: string, cancellable = true) {
        super(`${message}. Wait for the current operation to finish${cancellable ? ' or cancel it' : ''}.`);
    }
}

export class TargetOperation {
    readonly cancellation = new CancellationTokenSource();
    message: string;
    percent?: number;
    cancelling = false;

    constructor(readonly kind: TargetOperationKind, private changed: () => void) {
        this.message = labels[kind];
        this.cancellation.token.onCancellationRequested(() => this.cancel());
    }

    get cancellable(): boolean { return this.kind !== 'clean'; }

    get description(): string {
        const percent = this.percent === undefined || this.cancelling ? '' : ` · ${Math.floor(this.percent)}%`;
        return this.message.replace(/\s+/g, ' ') + percent;
    }

    report(message?: string, increment?: number): void {
        if (this.cancelling) { return; }
        const nextMessage = message || this.message;
        const nextPercent = increment !== undefined && Number.isFinite(increment) && increment >= 0
            ? Math.min(100, (this.percent ?? 0) + increment) : this.percent;
        if (nextMessage === this.message && nextPercent === this.percent) { return; }
        this.message = nextMessage;
        this.percent = nextPercent;
        this.changed();
    }

    cancel(): void {
        if (this.cancelling || !this.cancellable) { return; }
        this.cancelling = true;
        this.message = 'Cancelling…';
        this.changed();
        this.cancellation.cancel();
    }
}

// Each client owns its operations, so equal target URIs on different servers stay independent.
export class BspTargetOperations {
    private active = new Map<string, TargetOperation>();
    private exclusive?: TargetOperation;
    private listeners = new Set<(targetId: string) => void>();

    onDidChange(listener: (targetId: string) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    get first(): TargetOperation | undefined { return this.active.values().next().value; }

    get entries(): { targetId: string; operation: TargetOperation }[] {
        const seen = new Set<TargetOperation>();
        return [...this.active].flatMap(([targetId, operation]) => {
            if (seen.has(operation)) { return []; }
            seen.add(operation);
            return [{ targetId, operation }];
        });
    }

    get(targetId: string): TargetOperation | undefined { return this.exclusive ?? this.active.get(targetId); }

    async run<T>(targetId: string, kind: TargetOperationKind, action: (operation: TargetOperation) => Promise<T>): Promise<T> {
        const current = this.get(targetId) ?? (kind === 'clean' || targetId === 'workspace' ? this.first : undefined);
        if (current) { throw new TargetBusyError(current.message, current.cancellable); }
        const operation = new TargetOperation(kind, () => {
            if (this.active.get(targetId) === operation) { this.changed(targetId); }
        });
        this.active.set(targetId, operation);
        // A server can share caches across targets. Keep other requests out until cleaning finishes.
        if (kind === 'clean') { this.exclusive = operation; }
        this.changed(targetId);
        try { return await action(operation); }
        finally {
            operation.cancellation.dispose();
            if (this.exclusive === operation) { this.exclusive = undefined; }
            for (const [id, current] of this.active) {
                if (current === operation) {
                    this.active.delete(id);
                    this.changed(id);
                }
            }
        }
    }

    includeTargets(owner: string, targets: string[]): void {
        const operation = this.active.get(owner);
        if (!operation) { throw new Error('The target operation is no longer active'); }
        for (const target of targets) {
            const current = this.get(target);
            if (current && current !== operation) { throw new TargetBusyError(current.message, current.cancellable); }
        }
        for (const target of targets) { this.active.set(target, operation); this.changed(target); }
    }

    cancel(targetId: string): void { this.active.get(targetId)?.cancel(); }

    cancelAll(): void { for (const operation of this.active.values()) { operation.cancel(); } }

    clear(): void {
        this.cancelAll();
        const targets = [...this.active.keys()];
        this.active.clear();
        this.exclusive = undefined;
        for (const target of targets) { this.changed(target); }
    }

    private changed(targetId: string): void {
        for (const listener of this.listeners) { listener(targetId); }
    }
}
