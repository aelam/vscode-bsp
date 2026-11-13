import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

type DapMessage = Record<string, any>;

const previewCharacters = 8192;
const previewLines = 200;
const windowMilliseconds = 250;
const windowCharacters = 16384;
const windowEvents = 64;

/** Keep large debugger diagnostics out of the editor's console renderer. */
export class DebugConsoleOutput {
    private windowStart = -Infinity;
    private characters = 0;
    private events = 0;
    private warned = false;
    private archiveWarning = false;
    private disposed = false;
    readonly archive: DebugOutputArchive;

    constructor(
        private send: (message: DapMessage) => void,
        directory?: string,
        private now: () => number = () => performance.now()
    ) {
        this.archive = new DebugOutputArchive(directory, () => {
            if (!this.disposed) { this.notice('Could not save additional debugger output.'); }
        });
    }

    accept(message: DapMessage): void {
        if (this.disposed) { return; }
        if (message.type === 'event' && message.event === 'output'
            && message.body?.category !== 'telemetry' && typeof message.body?.output === 'string') {
            this.output(message);
            return;
        }
        if (message.type === 'response') {
            message = this.response(message);
        }
        this.send(message);
    }

    dispose(): void { this.disposed = true; }

    private output(message: DapMessage): void {
        const now = this.now();
        if (now - this.windowStart >= windowMilliseconds) {
            this.windowStart = now;
            this.characters = 0;
            this.events = 0;
            this.warned = false;
        }
        const original = message.body.output as string;
        const available = this.events < windowEvents ? windowCharacters - this.characters : 0;
        const text = preview(original, Math.max(0, Math.min(previewCharacters, available)));
        const limited = text !== original;
        if (!limited || text || message.body.group || message.body.variablesReference) {
            this.characters += text.length;
            this.events++;
            this.send(limited ? { ...message, body: { ...message.body, output: text } } : message);
        }
        if (limited) {
            const complete = this.archive.append('output', original);
            if (!this.warned) {
                this.warned = true;
                this.notice(`Debugger output limited to keep the window responsive. ${this.archiveLocation()}`,
                    this.archive.hasContent ? this.archive.file : undefined);
            }
            this.reportArchiveLimit(complete);
        }
    }

    private response(message: DapMessage): DapMessage {
        let limited = false;
        const shorten = (value: unknown, label: string): unknown => {
            if (typeof value !== 'string') { return value; }
            const text = preview(value, previewCharacters);
            if (text === value) { return value; }
            limited = true;
            this.reportArchiveLimit(this.archive.append(label, value));
            return `${text}\n[Display limited. ${this.archiveLocation()}]`;
        };
        // Preserve success, request IDs, and variable references, including on evaluate failures.
        const result = { ...message };
        if (typeof message.message === 'string') { result.message = shorten(message.message, 'response message'); }
        if (message.body && typeof message.body === 'object') {
            result.body = { ...message.body };
            if (message.command === 'evaluate' && typeof message.body.result === 'string') {
                result.body.result = shorten(message.body.result, 'evaluate');
            }
            if (message.body.error && typeof message.body.error === 'object') {
                result.body.error = { ...message.body.error };
                if (typeof message.body.error.format === 'string') {
                    result.body.error.format = shorten(message.body.error.format, 'response error');
                }
                if (message.body.error.variables && typeof message.body.error.variables === 'object') {
                    result.body.error.variables = Object.fromEntries(Object.entries(message.body.error.variables)
                        .map(([key, value]) => [key, shorten(value, 'response error variable')]));
                }
            }
        }
        if (limited) {
            this.notice(`Debugger response display limited. ${this.archiveLocation()}`,
                this.archive.hasContent ? this.archive.file : undefined);
        }
        return result;
    }

    private reportArchiveLimit(complete: boolean): void {
        if (complete || this.archiveWarning || this.archive.writeFailed) { return; }
        this.archiveWarning = true;
        this.notice('Additional debugger output exceeded the local log limit; the saved text is incomplete.');
    }

    private archiveLocation(): string {
        return this.archive.hasContent ? `Local log (may be incomplete): ${this.archive.file}`
            : 'Additional text could not be saved.';
    }

    private notice(text: string, file?: string): void {
        this.send({ type: 'event', event: 'output', body: { category: 'console', output: `${text}\n`,
            ...(file ? { source: { path: file }, line: 1 } : {}) } });
    }
}

/** Bound queued writes and disk use as well as the visible console output. */
export class DebugOutputArchive {
    readonly file: string;
    private queue: string[] = [];
    private queuedBytes = 0;
    private reservedBytes = 0;
    private writing?: Promise<void>;
    private failed = false;
    private readonly queueLimit = 8 * 1024 * 1024;
    private readonly fileLimit = 64 * 1024 * 1024;

    constructor(directory: string | undefined, private onError: () => void) {
        this.file = path.join(directory ?? path.join(os.tmpdir(), 'vscode-bsp-debug'), `debug-${randomUUID()}.log`);
    }

    get hasContent(): boolean { return !this.failed && this.reservedBytes > 0; }
    get writeFailed(): boolean { return this.failed; }

    append(label: string, text: string): boolean {
        if (this.failed) { return false; }
        const available = Math.min(this.queueLimit - this.queuedBytes, this.fileLimit - this.reservedBytes);
        if (this.queue.length >= 256 || available < 1024) { return false; }
        let entry = `\n[${label}]\n${text}\n`;
        const complete = Buffer.byteLength(entry) <= available;
        if (!complete) {
            // A UTF-16 code unit uses at most three UTF-8 bytes. Leave room for labels.
            entry = `\n[${label}; partial]\n${slice(text, 0, Math.floor((available - 256) / 3))}`
                + '\n[Local log limit reached; text omitted.]\n';
        }
        const size = Buffer.byteLength(entry);
        const last = this.queue.length - 1;
        if (last >= 0 && this.queue[last].length + entry.length <= 65536) {
            this.queue[last] += entry;
        } else {
            this.queue.push(entry);
        }
        this.queuedBytes += size;
        this.reservedBytes += size;
        this.writing ??= this.drain();
        return complete;
    }

    async settled(): Promise<void> { await this.writing; }

    private async drain(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            while (this.queue.length) {
                const entries = this.queue.splice(0);
                const bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0);
                await fs.appendFile(this.file, entries.join(''), { encoding: 'utf8', mode: 0o600 });
                this.queuedBytes -= bytes;
            }
        } catch {
            this.failed = true;
            this.queue = [];
            this.queuedBytes = 0;
            this.onError();
        } finally {
            this.writing = undefined;
        }
    }
}

function slice(text: string, start: number, end: number): string {
    if (start > 0 && text.charCodeAt(start) >= 0xDC00 && text.charCodeAt(start) <= 0xDFFF) { start++; }
    if (end < text.length && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF) { end--; }
    // Copy the preview so a short substring cannot retain a huge input string.
    return Buffer.from(text.slice(start, Math.max(start, end)), 'utf8').toString('utf8');
}

/** Inspect only a bounded prefix; do not split a potentially huge diagnostic into lines. */
function preview(text: string, limit: number): string {
    if (limit <= 0) { return ''; }
    if (text.length <= limit && text.split('\n').length <= previewLines) { return text; }
    const marker = '\n[... output omitted ...]\n';
    if (limit <= marker.length) { return slice(text, 0, limit); }
    const half = Math.floor((limit - marker.length) / 2);
    const head = slice(text, 0, half).split('\n').slice(0, previewLines / 2).join('\n');
    const tail = slice(text, Math.max(0, text.length - half), text.length)
        .split('\n').slice(-previewLines / 2).join('\n');
    return head + marker + tail;
}
