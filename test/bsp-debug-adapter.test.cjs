const assert = require('node:assert/strict');
const { test } = require('node:test');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { once } = require('node:events');
const { StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');

const load = Module._load;
Module._load = function (name, ...args) {
    if (name !== 'vscode') { return load.call(this, name, ...args); }
    return { EventEmitter: class {
        listeners = new Set();
        event = listener => {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
        };
        fire(message) { for (const listener of this.listeners) { listener(message); } }
        dispose() { this.listeners.clear(); }
    } };
};
let BspDebugAdapter;
try { ({ BspDebugAdapter } = require('../out/bspDebugAdapter')); }
finally { Module._load = load; }

function inbox() {
    const values = [], waiters = [];
    return {
        all: [],
        add(value) {
            this.all.push(value);
            const waiter = waiters.shift();
            if (waiter) { waiter(value); } else { values.push(value); }
        },
        next() {
            if (values.length) { return Promise.resolve(values.shift()); }
            return new Promise(resolve => waiters.push(resolve));
        }
    };
}

for (const transport of ['tcp', 'unix']) {
    test(`${transport} carries DAP messages, reverse requests, and stale thread recovery`, { timeout: 5000 }, async t => {
        const server = net.createServer();
        let directory, adapter, connection, reader, writer;
        t.after(async () => {
            adapter?.dispose();
            reader?.dispose();
            writer?.dispose();
            connection?.destroy();
            await new Promise(resolve => server.close(resolve));
            if (directory) { await fs.rm(directory, { recursive: true, force: true }); }
        });
        let endpoint;
        if (transport === 'unix') {
            directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-dap-'));
            endpoint = { socket: path.join(directory, 'dap.sock') };
            server.listen(endpoint.socket);
        } else {
            server.listen(0, '127.0.0.1');
        }
        await once(server, 'listening');
        endpoint ??= { host: '127.0.0.1', port: server.address().port };
        const connected = once(server, 'connection');
        const backend = inbox(), client = inbox();
        adapter = new BspDebugAdapter(endpoint);
        adapter.onDidSendMessage(message => client.add(message));
        adapter.handleMessage({ type: 'request', seq: 17, command: 'initialize', arguments: { adapterID: 'bsp' } });
        [connection] = await connected;
        reader = new StreamMessageReader(connection);
        writer = new StreamMessageWriter(connection);
        reader.listen(message => backend.add(message));
        const initialize = await backend.next();
        assert.equal(initialize.command, 'initialize');
        await writer.write({ type: 'response', seq: 80, request_seq: initialize.seq,
            command: 'initialize', success: true, body: {} });
        assert.equal((await client.next()).request_seq, 17);

        await writer.write({ type: 'request', seq: 81, command: 'runInTerminal',
            arguments: { args: ['/tmp/test program', '中文'] } });
        const reverse = await client.next();
        assert.deepEqual(reverse.arguments.args, ['/tmp/test program', '中文']);
        adapter.handleMessage({ type: 'response', seq: 18, request_seq: reverse.seq,
            command: 'runInTerminal', success: true, body: { processId: 42 } });
        assert.equal((await backend.next()).request_seq, 81);

        await writer.write({ type: 'event', seq: 82, event: 'stopped',
            body: { reason: 'breakpoint', threadId: 64424509454 } });
        assert.equal((await client.next()).event, 'stopped');
        adapter.handleMessage({ type: 'request', seq: 19, command: 'threads' });
        const threads = await backend.next();
        await writer.write({ type: 'response', seq: 83, request_seq: threads.seq,
            command: 'threads', success: true, body: { threads: [{ id: 1, name: 'Main thread' }] } });
        const retry = await backend.next();
        assert.equal(retry.command, 'threads');
        await writer.write({ type: 'response', seq: 84, request_seq: retry.seq,
            command: 'threads', success: true,
            body: { threads: [{ id: 1, name: 'Main thread' }, { id: 64424509454, name: '测试' }] } });
        const refreshed = await client.next();
        assert.equal(refreshed.request_seq, 19);
        assert.equal(refreshed.body.threads[1].name, '测试');

        if (transport === 'tcp') {
            connection.end();
            assert.equal((await client.next()).event, 'terminated');
            assert.equal(client.all.filter(message => message.event === 'terminated').length, 1);
        } else {
            const closed = once(connection, 'close');
            adapter.dispose();
            await closed;
            assert.equal(client.all.filter(message => message.event === 'terminated').length, 0);
        }
    });
}

test('a connection failure reports an error and ends the session once', { timeout: 5000 }, async t => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = { host: '127.0.0.1', port: server.address().port };
    await new Promise(resolve => server.close(resolve));
    const adapter = new BspDebugAdapter(endpoint);
    t.after(() => adapter.dispose());
    const client = inbox();
    adapter.onDidSendMessage(message => client.add(message));
    adapter.handleMessage({ type: 'request', seq: 1, command: 'initialize' });
    assert.equal((await client.next()).event, 'output');
    assert.equal((await client.next()).event, 'terminated');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.all.filter(message => message.event === 'terminated').length, 1);
});
