const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CancellationTokenSource } = require('vscode-jsonrpc/node');
const { BspCommunicationLog, logText } = require('../out/bspCommunicationLog');

function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

test('logs request timing and counts without serializing response payloads', async () => {
    const entries = [];
    let now = 10;
    const log = new BspCommunicationLog(() => 'server /workspace', (...entry) => entries.push(entry), 10000, 30000, () => now);
    const result = { targets: [{ secret: 'private-payload' }] };
    assert.equal(await log.request('workspace/buildTargets', async () => { now = 31; return result; }), result);
    assert.equal(entries.length, 2);
    assert.match(entries[0][1], /request #1 workspace\/buildTargets: sent/);
    assert.match(entries[1][1], /response received \(21 ms\) targets=1/);
    assert.ok(!JSON.stringify(entries).includes('private-payload'));
    assert.equal(log.pending.size, 0);
});

test('waiting messages do not finish or cancel a slow request', { timeout: 2000 }, async () => {
    const entries = [];
    const waiting = deferred();
    const reply = deferred();
    const log = new BspCommunicationLog(() => 'slow', (level, message) => {
        entries.push([level, message]);
        if (message.includes('waiting for response')) { waiting.resolve(); }
    }, 1, 10000);
    let finished = false;
    const request = log.request('build/initialize', () => reply.promise).then(value => { finished = true; return value; });
    // Keep the event loop alive while the logger's timer remains unreferenced.
    const deadline = setTimeout(() => waiting.reject(new Error('No waiting message')), 1000);
    try {
        await waiting.promise;
        assert.equal(finished, false);
        assert.equal(log.pending.size, 1);
        reply.resolve('ready');
        assert.equal(await request, 'ready');
        assert.equal(log.pending.size, 0);
        assert.ok(entries.some(([level]) => level === 'warn'));
    } finally {
        clearTimeout(deadline);
        log.close('test cleanup');
    }
});

test('cancellation is recorded while the original request still controls completion', async () => {
    const entries = [];
    const source = new CancellationTokenSource();
    const reply = deferred();
    const log = new BspCommunicationLog(() => 'server', (_, message) => entries.push(message));
    const request = log.request('buildTarget/compile', () => reply.promise, source.token);
    source.cancel();
    assert.equal(log.pending.size, 1);
    assert.equal(entries.filter(message => message.includes('cancellation requested')).length, 1);
    const failure = Object.assign(new Error('cancelled'), { code: -32800 });
    reply.reject(failure);
    await assert.rejects(request, error => error === failure);
    assert.equal(log.pending.size, 0);
    source.dispose();
});

test('closing stops all timers and subscriptions without changing request results', async () => {
    const entries = [];
    let disposed = 0;
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { disposed++; } }) };
    const first = deferred(), second = deferred();
    const log = new BspCommunicationLog(() => 'server', (_, message) => entries.push(message));
    const a = log.request('one', () => first.promise, token);
    const b = log.request('two', () => second.promise, token);
    log.close('Transport closed');
    assert.equal(log.pending.size, 0);
    assert.equal(disposed, 2);
    assert.equal(entries.filter(message => message.includes('before response')).length, 2);
    const count = entries.length;
    first.resolve(1); second.resolve(2);
    assert.deepEqual(await Promise.all([a, b]), [1, 2]);
    assert.equal(entries.length, count);
    assert.equal(disposed, 2);
});

test('synchronous failures keep their identity and bound error text', async () => {
    const entries = [];
    const log = new BspCommunicationLog(() => 'server\nlabel', (...entry) => entries.push(entry));
    const error = Object.assign(new Error('bad\n' + 'x'.repeat(2000)), { code: -32603 });
    await assert.rejects(log.request('method', () => { throw error; }), actual => actual === error);
    assert.equal(entries[1][0], 'error');
    assert.match(entries[1][1], /code=-32603/);
    assert.ok(entries[1][1].length < 700);
    assert.ok(!entries[1][1].includes('\n'));
    assert.equal(log.pending.size, 0);
    assert.equal(logText('a\r\nb'), 'a  b');
});
