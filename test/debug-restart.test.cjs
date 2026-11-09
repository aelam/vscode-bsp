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

const { disposeDebugEndpoint } = require('../out/debugEndpoint');

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

function deferred() {
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    return { promise, resolve };
}

function endSession(session) {
    for (const listener of terminated) { listener(session); }
}

function inbox() {
    const values = [], waiters = [];
    return {
        add(value) { const waiter = waiters.shift(); if (waiter) { waiter(value); } else { values.push(value); } },
        next() { return values.length ? Promise.resolve(values.shift()) : new Promise(resolve => waiters.push(resolve)); }
    };
}

async function harness(t, { transport = 'tcp', request = 'launch', legacy = false, pid, context = false, reuseSession = false } = {}) {
    const input = new PassThrough(), output = new PassThrough();
    const rpc = createMessageConnection(new StreamMessageReader(output), new StreamMessageWriter(input));
    const reader = new StreamMessageReader(input), writer = new StreamMessageWriter(output);
    const target = { id: { uri: 'target://hello' }, capabilities: { canRun: true, canDebug: true } };
    const endpoints = [], requests = [], options = [], tokens = [], gates = [];
    const cancellations = inbox();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-restart-'));
    const client = new BspClient(folder.uri, '/workspace/.bsp/server.json');
    client.connection = rpc;
    if (request === 'attach') { client.stopPreviousDebugSession = () => assert.fail('Attach must not stop the application'); }
    if (context) {
        client.contexts.negotiate({ bspExtensions: { 'vscode-bsp.build-context': {
            version: '0.1', required: true, operations: ['debug']
        } } });
        client.contexts.resolve = async () => ({ id: 'context', targets: [target.id], operation: 'debug', buildPolicy: 'build' });
    }
    const provider = new BspDebugConfigurationProvider((_folder, token, selected) => {
        options.push(selected);
        tokens.push(token);
        return client.prepareDebugConfiguration(target, token, selected.buildPolicy, selected.request);
    });
    const factory = new BspDebugAdapterDescriptorFactory(provider);
    let failNext = false;
    reader.listen(async message => {
        if (message.method === '$/cancelRequest') { cancellations.add(message); return; }
        requests.push(message);
        const gate = gates.shift();
        if (gate) { gate.arrived.resolve(message); await gate.resume.promise; }
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
        gate?.responded.resolve(endpoint);
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
    let session = { id: 'session', type: 'bsp-debug', workspaceFolder: folder, configuration: initial };
    return {
        requests, options, endpoints, client, factory, provider, tokens, cancellations,
        get session() { return session; },
        pauseNext() {
            const gate = { arrived: deferred(), resume: deferred(), responded: deferred() };
            gates.push(gate);
            return gate;
        },
        failNext() { failNext = true; },
        async open() {
            // Restart rebuilds the descriptor with the old resolved configuration, without calling the provider.
            const descriptor = await factory.createDebugAdapterDescriptor(session);
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
        async restart(endpoint, command = 'disconnect', notify = true) {
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
            const endedSession = session;
            endedSession.customRequest = () => assert.fail('The old session has ended');
            if (notify) {
                endSession(endedSession);
                if (!reuseSession) {
                    session = { ...session, configuration: JSON.parse(JSON.stringify(session.configuration)) };
                }
            }
            vscode.debug.activeDebugSession = endedSession;
            return endedSession;
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
    assert.equal(h.factory.preparations.size, 0);
    assert.equal(h.factory.restarting.size, 0);
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

async function expectCleanup(endpoint) {
    await endpoint.connected;
    const message = await endpoint.backend.next();
    assert.equal(message.command, 'disconnect');
    assert.deepEqual(message.arguments, { terminateDebuggee: false, suspendDebuggee: false, restart: false });
    const closed = once(endpoint.socket, 'close');
    await endpoint.writer.write({ type: 'response', seq: 1, request_seq: message.seq,
        command: 'disconnect', success: true });
    await closed;
    assert.equal(endpoint.connections, 1);
}

for (const transport of ['tcp', 'unix']) {
    for (const request of ['launch', 'attach']) {
        for (const context of [false, true]) {
            test(`${transport} ${request} ${context ? 'Context' : 'legacy'} Stop cancels Restart and releases its late endpoint`,
                { timeout: 10000 }, async t => {
                const h = await harness(t, { transport, request, context });
                const oldSession = await h.restart(await h.open());
                const gate = h.pauseNext();
                const pending = h.factory.createDebugAdapterDescriptor(h.session);
                const rejected = assert.rejects(pending, /cancelled/);
                const message = await gate.arrived.promise;
                // Ignore delayed events from an old session or an unrelated session.
                endSession(oldSession);
                endSession({ ...h.session, id: 'other' });
                assert.equal(h.tokens.at(-1).isCancellationRequested, false);
                endSession(h.session);
                assert.equal(h.tokens.at(-1).isCancellationRequested, true);
                assert.deepEqual((await h.cancellations.next()).params, { id: message.id });
                gate.resume.resolve();
                await expectCleanup(await gate.responded.promise);
                await rejected;
                assert.equal(h.requests.length, 2);
                assert.equal(h.client.getActiveRequests().size, 0);
                assert.equal(h.client.operations.get('target://hello'), undefined);
                assert.ok(h.requests.every(message => message.method === 'debugSession/start'));
                if (request === 'attach') {
                    for (const message of h.requests) {
                        assert.deepEqual(Object.keys(message.params).sort(),
                            context ? ['executionContext', 'originId', 'targets'] : ['arguments', 'originId', 'targets']);
                    }
                }
            });
        }
    }
}

test('disposing the factory cancels pending preparation and removes its event subscription', { timeout: 10000 }, async t => {
    const h = await harness(t);
    await h.restart(await h.open());
    const gate = h.pauseNext();
    const pending = h.factory.createDebugAdapterDescriptor(h.session);
    const rejected = assert.rejects(pending, /cancelled/);
    await gate.arrived.promise;
    const subscriptions = terminated.size;
    h.factory.dispose();
    h.factory.dispose();
    assert.equal(terminated.size, subscriptions - 1);
    assert.equal(h.tokens.at(-1).isCancellationRequested, true);
    gate.resume.resolve();
    await expectCleanup(await gate.responded.promise);
    await rejected;
    await assert.rejects(h.factory.createDebugAdapterDescriptor(h.session), /cancelled/);
    assert.equal(h.requests.length, 2);
});

test('a new preparation cancels its predecessor and waits for the target to be released', { timeout: 10000 }, async t => {
    const h = await harness(t);
    await h.restart(await h.open());
    const first = h.pauseNext();
    const pending = h.factory.createDebugAdapterDescriptor(h.session);
    const rejected = assert.rejects(pending, /cancelled/);
    await first.arrived.promise;
    const second = h.pauseNext();
    const replacement = h.factory.createDebugAdapterDescriptor(h.session);
    assert.equal(h.tokens.at(-1).isCancellationRequested, true);
    first.resume.resolve();
    await expectCleanup(await first.responded.promise);
    await rejected;
    await second.arrived.promise;
    assert.equal(h.factory.preparations.size, 1);
    assert.equal(h.factory.restarting.size, 1);
    assert.equal(h.tokens.at(-1).isCancellationRequested, false);
    second.resume.resolve();
    const endpoint = await second.responded.promise;
    const descriptor = await replacement;
    assert.equal(descriptor.implementation.endpoint.port, endpoint.server.address().port);
    assert.equal(endpoint.connections, 0);
    descriptor.implementation.dispose();
    assert.equal(h.requests.length, 3);
    assert.equal(h.client.operations.get('target://hello'), undefined);
});

test('the old Restart termination can arrive while the next descriptor is preparing', { timeout: 10000 }, async t => {
    const h = await harness(t, { request: 'attach' });
    const oldSession = await h.restart(await h.open(), 'disconnect', false);
    const gate = h.pauseNext();
    const pending = h.factory.createDebugAdapterDescriptor(h.session);
    await gate.arrived.promise;
    endSession(oldSession);
    assert.equal(h.tokens.at(-1).isCancellationRequested, false);
    gate.resume.resolve();
    await gate.responded.promise;
    const descriptor = await pending;
    descriptor.implementation.dispose();
    assert.equal(h.requests.length, 2);
});

test('Stop after the old Restart termination cancels preparation on the same session object', { timeout: 10000 }, async t => {
    const h = await harness(t, { request: 'attach' });
    const oldSession = await h.restart(await h.open(), 'disconnect', false);
    const gate = h.pauseNext();
    const pending = h.factory.createDebugAdapterDescriptor(h.session);
    const rejected = assert.rejects(pending, /cancelled/);
    await gate.arrived.promise;
    endSession(oldSession);
    endSession(h.session);
    assert.equal(h.tokens.at(-1).isCancellationRequested, true);
    gate.resume.resolve();
    await expectCleanup(await gate.responded.promise);
    await rejected;
});

for (const layer of ['provider', 'factory']) {
    test(`${layer} releases a configuration that arrives after cancellation`, { timeout: 10000 }, async t => {
        const h = await harness(t, { request: 'attach' });
        await h.restart(await h.open());
        const late = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(folder,
            { ...h.session.configuration.bspRestart });
        const endpoint = h.endpoints.at(-1);
        if (layer === 'provider') {
            h.provider.prepare = async () => { h.factory.dispose(); return late; };
        } else {
            h.provider.resolveDebugConfigurationWithSubstitutedVariables = async () => { h.factory.dispose(); return late; };
        }
        const rejected = assert.rejects(h.factory.createDebugAdapterDescriptor(h.session), /cancelled/);
        await expectCleanup(endpoint);
        await rejected;
        assert.equal(h.requests.length, 2);
    });
}

test('endpoint cleanup is bounded when the adapter does not respond', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const endpoint = h.endpoints[0];
    const cleanup = disposeDebugEndpoint(h.session.configuration.connect);
    await endpoint.connected;
    const closed = once(endpoint.socket, 'close');
    assert.equal((await endpoint.backend.next()).command, 'disconnect');
    await cleanup;
    await closed;
    await disposeDebugEndpoint(h.session.configuration.connect);
    await disposeDebugEndpoint('invalid://address');
});

for (const transport of ['tcp', 'unix']) {
    for (const request of ['launch', 'attach']) {
        test(`${transport} ${request} repeated Restarts on the same session object still allow Stop`, { timeout: 10000 }, async t => {
            const h = await harness(t, { transport, request, reuseSession: true });
            const session = h.session;
            for (const command of ['disconnect', 'terminate']) {
                await h.restart(await h.open(), command);
                assert.equal(h.session, session);
            }
            // Delay the third Restart's termination until its preparation has started.
            await h.restart(await h.open(), 'disconnect', false);
            const gate = h.pauseNext();
            const pending = h.factory.createDebugAdapterDescriptor(session);
            const rejected = assert.rejects(pending, /cancelled/);
            await gate.arrived.promise;
            endSession(session);
            assert.equal(h.tokens.at(-1).isCancellationRequested, false);
            endSession(session);
            assert.equal(h.tokens.at(-1).isCancellationRequested, true);
            gate.resume.resolve();
            await expectCleanup(await gate.responded.promise);
            await rejected;
            assert.equal(h.requests.length, 4);
            assert.equal(h.factory.preparations.size, 0);
            assert.equal(h.factory.restarting.size, 0);
            assert.equal(h.client.operations.get('target://hello'), undefined);
        });
    }
}
