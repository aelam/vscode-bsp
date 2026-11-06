type DapMessage = Record<string, any>;
interface PendingRequest {
    clientSeq: number;
    command: string;
    arguments?: unknown;
    retry?: { response: DapMessage; timer: ReturnType<typeof setTimeout> };
}

/** Refresh a stale thread list before the editor selects a stopped thread. */
export class DapThreadRefresh {
    private backendSequence = 0;
    private clientSequence = 0;
    private stoppedThread?: number;
    private pending = new Map<number, PendingRequest>();
    private reverseRequests = new Map<number, number>();
    private disposed = false;

    constructor(
        private sendBackend: (message: DapMessage) => void,
        private sendClient: (message: DapMessage) => void,
        private retryTimeout = 2000
    ) {}

    fromClient(message: DapMessage): void {
        if (this.disposed) { return; }
        const forwarded: DapMessage = { ...message, seq: ++this.backendSequence };
        if (message.type === 'request') {
            this.pending.set(forwarded.seq, {
                clientSeq: message.seq, command: message.command, arguments: message.arguments
            });
        } else if (message.type === 'response') {
            forwarded.request_seq = this.reverseRequests.get(message.request_seq) ?? message.request_seq;
            this.reverseRequests.delete(message.request_seq);
        }
        this.sendBackend(forwarded);
    }

    fromBackend(message: DapMessage): void {
        if (this.disposed) { return; }
        if (message.type === 'event') {
            if (message.event === 'stopped') {
                this.flushRetries();
                const id = message.body?.threadId;
                this.stoppedThread = Number.isSafeInteger(id) && id > 0 ? id : undefined;
            } else if (message.event === 'continued' || message.event === 'terminated'
                || message.event === 'exited'
                || (message.event === 'thread' && message.body?.reason === 'exited'
                    && message.body.threadId === this.stoppedThread)) {
                this.stoppedThread = undefined;
                this.flushRetries();
            }
        }
        if (message.type !== 'response') { this.deliver(message); return; }
        const request = this.pending.get(message.request_seq);
        if (!request) { return; }
        this.pending.delete(message.request_seq);
        if (request.retry) {
            clearTimeout(request.retry.timer);
            this.deliver({ ...(message.success ? message : request.retry.response), request_seq: request.clientSeq });
            return;
        }
        const threads = message.body?.threads;
        if (request.command === 'threads' && message.success && Array.isArray(threads)
            && this.stoppedThread !== undefined && !threads.some(thread => thread.id === this.stoppedThread)) {
            const seq = ++this.backendSequence;
            const timer = setTimeout(() => {
                if (!this.pending.delete(seq) || this.disposed) { return; }
                this.deliver({ ...message, request_seq: request.clientSeq });
            }, this.retryTimeout);
            this.pending.set(seq, { ...request, retry: { response: message, timer } });
            this.sendBackend({ seq, type: 'request', command: 'threads', arguments: request.arguments ?? {} });
            return;
        }
        this.deliver({ ...message, request_seq: request.clientSeq });
    }

    dispose(): void {
        this.disposed = true;
        for (const request of this.pending.values()) {
            if (request.retry) { clearTimeout(request.retry.timer); }
        }
        this.pending.clear();
        this.reverseRequests.clear();
    }

    private flushRetries(): void {
        for (const [seq, request] of this.pending) {
            if (!request.retry) { continue; }
            clearTimeout(request.retry.timer);
            this.pending.delete(seq);
            this.deliver({ ...request.retry.response, request_seq: request.clientSeq });
        }
    }

    private deliver(message: DapMessage): void {
        const seq = ++this.clientSequence;
        if (message.type === 'request') { this.reverseRequests.set(seq, message.seq); }
        this.sendClient({ ...message, seq });
    }
}
