const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DapThreadRefresh } = require('../out/dapThreadRefresh');

function fixture(timeout = 2000) {
    const backend = [], client = [];
    return { backend, client, bridge: new DapThreadRefresh(m => backend.push(m), m => client.push(m), timeout) };
}
const stopped = { type: 'event', seq: 90, event: 'stopped', body: { threadId: 90000000001, reason: 'breakpoint' } };
function response(request, threads, success = true) {
    return { type: 'response', seq: 100, request_seq: request.seq, command: request.command,
        success, body: { threads } };
}

test('refreshes a stale list and preserves request identities in both directions', () => {
    const f = fixture();
    f.bridge.fromBackend(stopped);
    f.bridge.fromClient({ type: 'request', seq: 40, command: 'threads', arguments: {} });
    f.bridge.fromBackend(response(f.backend[0], [{ id: 1, name: 'Main thread' }]));
    assert.equal(f.client.length, 1);
    assert.equal(f.backend.length, 2);
    assert.equal(f.backend[1].command, 'threads');
    f.bridge.fromBackend({ type: 'request', seq: 101, command: 'runInTerminal', arguments: { args: ['tool'] } });
    const reverse = f.client.at(-1);
    f.bridge.fromClient({ type: 'response', seq: 41, request_seq: reverse.seq, command: 'runInTerminal', success: true });
    assert.equal(f.backend.at(-1).request_seq, 101);
    f.bridge.fromBackend(response(f.backend[1], [{ id: 1 }, { id: stopped.body.threadId, name: 'Paused test' }]));
    const result = f.client.at(-1);
    assert.equal(result.request_seq, 40);
    assert.equal(result.body.threads[1].id, stopped.body.threadId);
    assert.deepEqual(f.backend.map(m => m.seq), [1, 2, 3]);
    assert.deepEqual(f.client.map(m => m.seq), [1, 2, 3]);
    f.bridge.dispose();
});

test('passes complete thread lists and other responses without extra requests', () => {
    const f = fixture();
    f.bridge.fromBackend(stopped);
    f.bridge.fromClient({ type: 'request', seq: 7, command: 'threads' });
    f.bridge.fromBackend(response(f.backend[0], [{ id: stopped.body.threadId }]));
    assert.equal(f.backend.length, 1);
    assert.equal(f.client.at(-1).request_seq, 7);
    f.bridge.fromClient({ type: 'request', seq: 8, command: 'stackTrace', arguments: { threadId: stopped.body.threadId } });
    const frames = [{ name: 'testExample', source: { path: '/tests/Example.swift' }, line: 12 }];
    f.bridge.fromBackend({ type: 'response', seq: 91, request_seq: f.backend[1].seq,
        command: 'stackTrace', success: true, body: { stackFrames: frames } });
    assert.equal(f.client.at(-1).request_seq, 8);
    assert.deepEqual(f.client.at(-1).body.stackFrames, frames);
    f.bridge.dispose();
});

test('retries only once and preserves a usable response if the retry fails', () => {
    for (const success of [false, true]) {
        const f = fixture();
        f.bridge.fromBackend(stopped);
        f.bridge.fromClient({ type: 'request', seq: 7, command: 'threads' });
        const initial = response(f.backend[0], [{ id: 1 }]);
        f.bridge.fromBackend(initial);
        f.bridge.fromBackend(response(f.backend[1], [{ id: 2 }], success));
        assert.equal(f.backend.length, 2);
        assert.equal(f.client.at(-1).success, true);
        assert.deepEqual(f.client.at(-1).body.threads, [{ id: success ? 2 : 1 }]);
        f.bridge.dispose();
    }
});

test('resuming a target prevents a late refresh from restoring an old stopped thread', () => {
    const f = fixture();
    f.bridge.fromBackend(stopped);
    f.bridge.fromClient({ type: 'request', seq: 7, command: 'threads' });
    f.bridge.fromBackend(response(f.backend[0], [{ id: 1 }]));
    const retry = f.backend[1];
    f.bridge.fromBackend({ type: 'event', seq: 102, event: 'continued', body: { allThreadsContinued: true } });
    const count = f.client.length;
    f.bridge.fromBackend(response(retry, [{ id: stopped.body.threadId }]));
    assert.equal(f.client.length, count);
    assert.equal(f.client.at(-1).event, 'continued');
    f.bridge.dispose();
});

test('a stalled refresh times out and disposal cancels outstanding work', async () => {
    for (const dispose of [false, true]) {
        const f = fixture(10);
        f.bridge.fromBackend(stopped);
        f.bridge.fromClient({ type: 'request', seq: 7, command: 'threads' });
        f.bridge.fromBackend(response(f.backend[0], [{ id: 1 }]));
        if (dispose) { f.bridge.dispose(); }
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(f.client.length, dispose ? 1 : 2);
        f.bridge.fromBackend(response(f.backend[1], [{ id: stopped.body.threadId }]));
        assert.equal(f.client.length, dispose ? 1 : 2);
        f.bridge.dispose();
    }
});
