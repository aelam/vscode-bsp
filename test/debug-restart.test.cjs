const assert = require('node:assert/strict');
const { test } = require('node:test');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationToken } = require('vscode-jsonrpc/node');

const folder = { uri: { fsPath: '/workspace' } };
const terminated = new Set();
const vscode = {
    EventEmitter: class {
        listeners = new Set();
        event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
        fire(value) { for (const listener of this.listeners) { listener(value); } }
        dispose() { this.listeners.clear(); }
    },
    DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } },
    languages: { createDiagnosticCollection: () => ({}) },
    workspace: { getWorkspaceFolder: () => folder, getConfiguration: () => ({ get: () => [] }) },
    ProgressLocation: { Notification: 15 },
    window: {
        withProgress: (_options, action) => action({ report() {} }, CancellationToken.None),
        showErrorMessage() {}, showInformationMessage() {}
    },
    debug: {
        onDidStartDebugSession: () => ({ dispose() {} }),
        onDidTerminateDebugSession: listener => { terminated.add(listener); return { dispose: () => terminated.delete(listener) }; },
        startDebugging: async () => assert.fail('Restart must reuse the VS Code session')
    }
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let BspClient, BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory;
try {
    ({ BspClient } = require('../out/bspClient'));
    ({ BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory } = require('../out/debugProvider'));
} finally { Module._load = load; }

function inbox() {
    const values = [], waiters = [];
    return {
        add(value) { const waiter = waiters.shift(); if (waiter) { waiter(value); } else { values.push(value); } },
        next() { return values.length ? Promise.resolve(values.shift()) : new Promise(resolve => waiters.push(resolve)); }
    };
}

async function harness(t, { transport = 'tcp', request = 'launch', legacy = false, pid } = {}) {
    const input = new PassThrough(), output = new PassThrough();
    const rpc = createMessageConnection(new StreamMessageReader(output), new StreamMessageWriter(input));
    const reader = new StreamMessageReader(input), writer = new StreamMessageWriter(output);
    const target = { id: { uri: 'target://hello' } };
    const endpoints = [], requests = [], options = [];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-restart-'));
    const client = new BspClient(folder.uri, '/workspace/.bsp/server.json');
    client.connection = rpc;
    const provider = new BspDebugConfigurationProvider((_folder, token, selected) => {
        options.push(selected);
        return client.prepareDebugConfiguration(target, token, selected.buildPolicy, selected.request);
    });
    const factory = new BspDebugAdapterDescriptorFactory(provider);
    let failNext = false;
    reader.listen(async message => {
        requests.push(message);
        if (failNext) {
            await writer.write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'No matching process' } });
            return;
        }
        const index = endpoints.length + 1;
        const server = net.createServer();
        const endpoint = { server, backend: inbox(), client: inbox(), sequence: 0, connections: 0 };
        endpoints.push(endpoint);
        endpoint.connected = once(server, 'connection').then(([socket]) => {
            endpoint.connections++;
            endpoint.socket = socket;
            server.close(); // Each BSP endpoint accepts one connection.
            endpoint.reader = new StreamMessageReader(socket);
            endpoint.writer = new StreamMessageWriter(socket);
            endpoint.reader.listen(message => endpoint.backend.add(message));
        });
        const socket = path.join(directory, `${index}.sock`);
        server.listen(...(transport === 'unix' ? [socket] : [0, '127.0.0.1']));
        await once(server, 'listening');
        const uri = transport === 'unix' ? `unix://${socket}` : `tcp://127.0.0.1:${server.address().port}`;
        const result = { uri, ...(legacy ? { data: {
            request: 'attach', pid: 100 + index, program: `/app/${index}`, args: [`${index}`], env: { RUN: `${index}` }, cwd: `/run/${index}`
        } } : {}) };
        await writer.write({ jsonrpc: '2.0', id: message.id, result });
    });
    rpc.listen();
    t.after(async () => {
        vscode.debug.activeDebugSession = undefined;
        factory.dispose(); client.debugSessions.dispose(); rpc.dispose(); reader.dispose(); writer.dispose();
        input.destroy(); output.destroy();
        for (const endpoint of endpoints) {
            endpoint.adapter?.dispose(); endpoint.reader?.dispose(); endpoint.writer?.dispose(); endpoint.socket?.destroy();
            await new Promise(resolve => endpoint.server.close(resolve));
        }
        await fs.rm(directory, { recursive: true, force: true });
    });
    const initial = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, {
        type: 'bsp-debug', name: 'Example', request, target: target.id.uri, connection: '/workspace/.bsp/server.json',
        stopOnEntry: true, initCommands: ['settings set target.preload-symbols false'], ...(pid ? { pid } : {})
    });
    const session = { id: 'session', workspaceFolder: folder, configuration: initial };
    return {
        requests, options, endpoints, session, client, factory, provider,
        failNext() { failNext = true; },
        async open() {
            // Restart rebuilds the descriptor with the old resolved configuration, without calling the provider.
            const descriptor = await factory.createDebugAdapterDescriptor({ ...session,
                configuration: JSON.parse(JSON.stringify(session.configuration)) });
            const endpoint = endpoints.at(-1);
            endpoint.adapter = descriptor.implementation;
            endpoint.adapter.onDidSendMessage(message => endpoint.client.add(message));
            endpoint.send = (command, args) => endpoint.adapter.handleMessage({
                type: 'request', seq: ++endpoint.sequence, command, arguments: args
            });
            endpoint.respond = (message, body = {}) => endpoint.writer.write({
                type: 'response', seq: 1000 + message.seq, request_seq: message.seq, command: message.command, success: true, body
            });
            endpoint.send('initialize', { adapterID: 'bsp-debug' });
            await endpoint.connected;
            const initialize = await endpoint.backend.next();
            await endpoint.respond(initialize, { supportsRestartRequest: true, supportsConfigurationDoneRequest: true });
            assert.equal((await endpoint.client.next()).body.supportsRestartRequest, false);
            await endpoint.writer.write({ type: 'event', seq: 2000, event: 'capabilities', body: {
                capabilities: { supportsRestartRequest: true, supportsTerminateRequest: true }
            } });
            const capabilities = await endpoint.client.next();
            assert.equal(capabilities.body.capabilities.supportsRestartRequest, false);
            assert.equal(capabilities.body.capabilities.supportsTerminateRequest, true);
            endpoint.send(initial.request, initial);
            const start = await endpoint.backend.next();
            assert.equal(start.command, legacy ? 'attach' : request);
            assert.equal(start.arguments.pid, legacy ? 100 + endpoints.length : pid);
            assert.deepEqual(start.arguments.initCommands, initial.initCommands);
            assert.equal(start.arguments.stopOnEntry, true);
            for (const key of ['bspOwner', 'bspTarget', 'bspAttach', 'bspRestart']) { assert.equal(start.arguments[key], undefined); }
            if (legacy) {
                assert.equal(start.arguments.program, `/app/${endpoints.length}`);
                assert.deepEqual(start.arguments.args, [`${endpoints.length}`]);
                assert.deepEqual(start.arguments.env, { RUN: `${endpoints.length}` });
                assert.equal(start.arguments.cwd, `/run/${endpoints.length}`);
            }
            await endpoint.respond(start);
            assert.equal((await endpoint.client.next()).command, initial.request);
            endpoint.send('setBreakpoints', { source: { path: '/app/main.swift' }, breakpoints: [{ line: 7 }] });
            const breakpoints = await endpoint.backend.next();
            assert.equal(breakpoints.command, 'setBreakpoints');
            await endpoint.respond(breakpoints, { breakpoints: [{ verified: true, line: 7 }] });
            assert.equal((await endpoint.client.next()).body.breakpoints[0].verified, true);
            endpoint.send('configurationDone', {});
            await endpoint.respond(await endpoint.backend.next());
            await endpoint.client.next();
            return endpoint;
        },
        async restart(endpoint, command = 'disconnect') {
            endpoint.send(command, { restart: true, terminateDebuggee: true });
            const end = await endpoint.backend.next();
            assert.equal(end.command, request === 'attach' ? 'disconnect' : command);
            assert.equal(end.arguments.restart, false);
            assert.equal(end.arguments.terminateDebuggee, request !== 'attach');
            if (request === 'attach') { assert.equal(end.arguments.suspendDebuggee, false); }
            await endpoint.respond(end);
            assert.equal((await endpoint.client.next()).command, command);
            const closed = once(endpoint.socket, 'close');
            endpoint.socket.end();
            assert.equal((await endpoint.client.next()).event, 'terminated');
            endpoint.adapter.dispose();
            await closed;
            const endedSession = { ...session, type: 'bsp-debug', customRequest: () => assert.fail('The old session has ended') };
            for (const listener of terminated) { listener(endedSession); }
            vscode.debug.activeDebugSession = endedSession;
        }
    };
}

for (const transport of ['tcp', 'unix']) {
    for (const scenario of [{ request: 'launch' }, { request: 'launch', legacy: true }, { request: 'attach' }, { request: 'attach', pid: 42 }]) {
        test(`${transport} ${scenario.request}${scenario.legacy ? ' via native attach' : ''}${scenario.pid ? ' with PID' : ''} restarts through fresh BSP endpoints`, { timeout: 10000 }, async t => {
            const h = await harness(t, { transport, ...scenario });
            for (let round = 0; round < 3; round++) {
                const endpoint = await h.open();
                assert.equal(h.requests.length, round + 1);
                assert.equal(endpoint.connections, 1);
                if (round < 2) { await h.restart(endpoint, round ? 'terminate' : 'disconnect'); }
            }
            for (const message of h.requests) {
                assert.equal(message.method, 'debugSession/start');
                assert.deepEqual(Object.keys(message.params).sort(), ['arguments', 'originId', 'targets']);
                assert.deepEqual(message.params.targets, [{ uri: 'target://hello' }]);
                assert.deepEqual(message.params.arguments, []);
            }
            for (const options of h.options) {
                assert.equal(options.request, scenario.request);
                assert.equal(options.target, 'target://hello');
                assert.equal(options.connection, '/workspace/.bsp/server.json');
            }
        });
    }
}

test('a failed restart reports the BSP error without reconnecting to the old endpoint', { timeout: 10000 }, async t => {
    const h = await harness(t, { request: 'attach' });
    const endpoint = await h.open();
    await h.restart(endpoint);
    h.failNext();
    await assert.rejects(h.factory.createDebugAdapterDescriptor(h.session), /No matching process/);
    assert.equal(h.requests.length, 2);
    assert.equal(h.endpoints.length, 1);
    assert.equal(endpoint.connections, 1);
});

test('a fresh configuration from an edited launch file does not request another endpoint', { timeout: 10000 }, async t => {
    const h = await harness(t);
    await h.restart(await h.open());
    h.session.configuration = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(folder,
        { ...h.session.configuration.bspRestart, stopOnEntry: false });
    const descriptor = await h.factory.createDebugAdapterDescriptor(h.session);
    assert.deepEqual(descriptor.implementation.endpoint, h.session.configuration.connect);
    assert.equal(h.requests.length, 2);
    descriptor.implementation.dispose();
});

test('restart metadata preserves the build policy and the requested mode', () => {
    const client = new BspClient(folder.uri, '/workspace/.bsp/server.json');
    try {
        const configuration = client.configurationForDebugResult({ uri: 'tcp://localhost:12345', data: { request: 'attach', pid: 123 } },
            'target://hello', 'launch', 'reuse');
        assert.equal(configuration.bspRestart.buildPolicy, 'reuse');
        assert.equal(configuration.bspRestart.request, 'launch');
        assert.equal(configuration.bspRestart.pid, undefined);
        assert.equal(configuration.bspRestart.connect, undefined);
    } finally { client.debugSessions.dispose(); }
});
