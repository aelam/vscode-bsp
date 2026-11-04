import { Transform, TransformCallback } from 'stream';

// Keep unframed stdout out of the JSON-RPC reader. Payloads pass through unchanged.
export class BspStdio extends Transform {
    private pending = Buffer.alloc(0);
    private remaining = 0;
    private static readonly marker = 'content-length:';
    private static readonly maxHeader = 8192;

    constructor(private logOutput: (message: string) => void) { super(); }

    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            this.pending = Buffer.concat([this.pending, chunk]);
            this.drain();
            callback();
        } catch (error) { callback(error as Error); }
    }

    private drain(): void {
        while (this.pending.length) {
            if (this.remaining) {
                const count = Math.min(this.remaining, this.pending.length);
                this.push(this.pending.subarray(0, count));
                this.pending = this.pending.subarray(count);
                this.remaining -= count;
                continue;
            }
            const text = this.pending.toString('utf8');
            const start = text.search(/content-(?:length|type):/i);
            if (start < 0) {
                const newline = this.pending.lastIndexOf(10);
                if (newline >= 0) { this.output(newline + 1); continue; }
                if (this.pending.length > BspStdio.maxHeader) {
                    // Retain a possible partial header and UTF-8 character at the boundary.
                    this.output(this.pending.length - BspStdio.marker.length - 4);
                }
                return;
            }
            if (start > 0) {
                this.output(Buffer.byteLength(text.slice(0, start)));
                continue;
            }
            const end = this.pending.indexOf('\r\n\r\n');
            if (end < 0) {
                if (this.pending.length > BspStdio.maxHeader) { throw new Error('BSP header is too large'); }
                return;
            }
            if (end > BspStdio.maxHeader) { throw new Error('BSP header is too large'); }
            const header = this.pending.subarray(0, end).toString('ascii');
            const match = /(?:^|\r\n)content-length:[ \t]*(\d+)[ \t]*(?:\r\n|$)/i.exec(header);
            const length = match ? Number(match[1]) : NaN;
            if (!Number.isSafeInteger(length) || length <= 0 || length > 64 * 1024 * 1024) {
                throw new Error('Invalid BSP Content-Length');
            }
            this.push(this.pending.subarray(0, end + 4));
            this.pending = this.pending.subarray(end + 4);
            this.remaining = length;
        }
    }

    private output(count: number): void {
        while (count < this.pending.length && count > 0 && (this.pending[count] & 0xc0) === 0x80) { count--; }
        const text = this.pending.subarray(0, count).toString('utf8').trimEnd();
        this.pending = this.pending.subarray(count);
        if (text) { this.logOutput(text); }
    }

    _flush(callback: TransformCallback): void {
        if (this.remaining || /^content-(?:length|type):/i.test(this.pending.toString('ascii'))) {
            callback(new Error('BSP stdout ended during a message'));
        } else {
            this.output(this.pending.length);
            callback();
        }
    }
}
