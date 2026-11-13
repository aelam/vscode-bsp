import { performance } from 'perf_hooks';
import type { CancellationToken } from 'vscode-jsonrpc/node';

type Level = 'info' | 'warn' | 'error';
type WriteLog = (level: Level, message: string) => void;
interface PendingRequest {
    method: string;
    started: number;
    timer?: ReturnType<typeof setTimeout>;
    cancellation?: { dispose(): void };
}

export function logText(value: string | undefined, limit = 300): string {
    // eslint-disable-next-line no-control-regex -- Keep each log entry on one line.
    const text = (value ?? 'unavailable').replace(/[\x00-\x1f\x7f]/g, ' ');
    return text.length > limit ? text.slice(0, limit) + '…' : text;
}

// Request numbers correlate client log entries; they are not JSON-RPC IDs.
export class BspCommunicationLog {
    private sequence = 0;
    private pending = new Map<number, PendingRequest>();

    constructor(private label: () => string, private write: WriteLog,
        private slowAfterMs = 10000, private repeatAfterMs = 30000,
        private now: () => number = () => performance.now()) {}

    event(message: string, level: Level = 'info'): void {
        this.write(level, `[BSP ${logText(this.label())}] ${message}`);
    }

    async request<T>(method: string, send: () => Promise<T>, token?: CancellationToken): Promise<T> {
        const id = ++this.sequence;
        const request: PendingRequest = { method: logText(method), started: this.now() };
        this.pending.set(id, request);
        const prefix = `request #${id} ${request.method}`;
        this.event(`${prefix}: sent`);
        const waiting = () => {
            if (!this.pending.has(id)) { return; }
            this.event(`${prefix}: waiting for response (${this.elapsed(request)}); server work may still be running`, 'warn');
            request.timer = setTimeout(waiting, this.repeatAfterMs);
            request.timer.unref();
        };
        request.timer = setTimeout(waiting, this.slowAfterMs);
        request.timer.unref();
        let cancelled = false;
        const cancel = () => {
            if (cancelled || !this.pending.has(id)) { return; }
            cancelled = true;
            this.event(`${prefix}: cancellation requested (${this.elapsed(request)}); waiting for response`);
        };
        request.cancellation = token?.onCancellationRequested(cancel);
        if (token?.isCancellationRequested) { cancel(); }
        try {
            const result = await send();
            if (this.pending.has(id)) {
                this.event(`${prefix}: response received (${this.elapsed(request)})${summary(result)}`);
            }
            return result;
        } catch (error) {
            if (this.pending.has(id)) {
                const code = object(error)?.code;
                const detail = error instanceof Error ? error.message : String(error);
                this.event(`${prefix}: failed (${this.elapsed(request)})${typeof code === 'number' ? ` code=${code}` : ''}: ${logText(detail, 500)}`,
                    cancelled || code === -32800 ? 'warn' : 'error');
            }
            throw error;
        } finally {
            this.remove(id, request);
        }
    }

    close(reason: string): void {
        for (const [id, request] of this.pending) {
            this.event(`request #${id} ${request.method}: ${reason} before response (${this.elapsed(request)})`, 'warn');
            this.remove(id, request);
        }
    }

    private elapsed(request: PendingRequest): string {
        return `${Math.max(0, Math.round(this.now() - request.started))} ms`;
    }

    private remove(id: number, request: PendingRequest): void {
        if (!this.pending.delete(id)) { return; }
        if (request.timer) { clearTimeout(request.timer); }
        request.cancellation?.dispose();
    }
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function summary(result: unknown): string {
    const data = object(result);
    if (!data) { return ''; }
    if (typeof data.statusCode === 'number') { return ` status=${data.statusCode}`; }
    if (Array.isArray(data.targets)) { return ` targets=${data.targets.length}`; }
    if (Array.isArray(data.items)) { return ` items=${data.items.length}`; }
    return '';
}
