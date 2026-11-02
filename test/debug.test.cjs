const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { PassThrough } = require('node:stream');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource } = require('vscode-jsonrpc/node');
const { debugConfiguration } = require('../out/debugConfiguration');

const starts = [];
const folder = { uri: { fsPath: '/hello' } };
let startResult = true;
const vscode = {
    DebugAdapterServer: class { constructor(port, host) { Object.assign(this, { port, host }); } },
    DebugAdapterNamedPipeServer: class { constructor(path) { this.path = path; } },
    languages: { createDiagnosticCollection: () => ({}) },
    workspace: { getWorkspaceFolder: () => folder },
    debug: {
        onDidStartDebugSession: () => ({ dispose() {} }),
        onDidTerminateDebugSession: () => ({ dispose() {} }),
        startDebugging: async (...args) => { starts.push(args); return startResult; }
    }
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let BspClient, BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory;
try {
    ({ BspClient } = require('../out/bspClient'));
    ({ BspDebugConfigurationProvider, BspDebugAdapterDescriptorFactory } = require('../out/debugProvider'));
} finally { Module._load = load; }

test('uses each server-assigned address and preserves attach and launch parameters', () => {
    for (const port of [12345, 54321]) {
        const config = debugConfiguration({ uri: `tcp://127.0.0.1:${port}`, data: { request: 'attach', pid: 42 } }, 'Hello');
        assert.deepEqual(config.connect, { host: '127.0.0.1', port });
        assert.equal(config.request, 'attach');
        assert.equal(config.pid, 42);
    }
    const unix = debugConfiguration({ uri: 'unix:///tmp/bsp%20debug.sock', data: { request: 'launch', program: '/tmp/Hello' } }, 'Hello');
    assert.deepEqual(unix.connect, { socket: '/tmp/bsp debug.sock' });
    assert.equal(unix.request, 'launch');
    assert.equal(unix.program, '/tmp/Hello');
    assert.deepEqual(debugConfiguration({ uri: 'tcp://[::1]:23456' }, 'Hello').connect, { host: '::1', port: 23456 });
});

test('rejects invalid endpoints without falling back to port 5005', () => {
    for (const uri of ['tcp://localhost', 'tcp://localhost:0', 'tcp://localhost:70000', 'http://localhost:5005', 'unix:///']) {
        assert.throws(() => debugConfiguration({ uri }, 'Hello'));
    }
});

test('F5 prepares one BSP request and does not start a nested VS Code session', async () => {
    const client = new BspClient(folder.uri, '/hello/.bsp/config.json', undefined, {
        getDebugInfo: () => ({}), canHandle: () => true,
        getRunArguments: async () => ['-configuration', 'Debug', '-destination', 'id=PHONE']
    });
    const target = { id: { uri: 'target://hello' }, displayName: 'Hello' };
    const token = { isCancellationRequested: false };
    let requests = 0;
    client.connection = { sendRequest: async (method, params, receivedToken) => {
        assert.equal(method, 'debugSession/start');
        assert.deepEqual(params.targets, [target.id]);
        assert.deepEqual(params.arguments, ['-configuration', 'Debug', '-destination', 'id=PHONE']);
        assert.equal(receivedToken, token);
        requests++;
        return { uri: `tcp://127.0.0.1:${20000 + requests}`, data: { request: 'attach', pid: 42 } };
    } };
    const provider = new BspDebugConfigurationProvider((receivedFolder, receivedToken) => {
        assert.equal(receivedFolder, folder);
        return client.prepareDebugConfiguration(target, receivedToken);
    });
    for (const port of [20001, 20002]) {
        const config = await provider.resolveDebugConfiguration(folder,
            { type: 'bsp-debug', request: 'launch', name: 'BSP Debug', stopOnEntry: true }, token);
        assert.equal(config.connect.port, port);
        assert.equal(config.request, 'attach');
        assert.equal(config.stopOnEntry, true);
        assert.equal(config.bspTarget, target.id.uri);
        assert.equal(config.bspOwner, '/hello/.bsp/config.json');
        const descriptor = new BspDebugAdapterDescriptorFactory().createDebugAdapterDescriptor({ configuration: config });
        assert.equal(descriptor.port, port);
    }
    assert.equal(requests, 2);
    assert.equal(starts.length, 0);
    client.debugSessions.dispose();
});

test('target toolbar starts one session and propagates VS Code startup failures', async () => {
    const client = new BspClient(folder.uri);
    client.connection = { sendRequest: async () => ({ uri: 'tcp://127.0.0.1:25000', data: { request: 'launch', program: '/tmp/Hello' } }) };
    const target = { id: { uri: 'target://hello' } };
    await client.debug(target);
    assert.equal(starts.length, 1);
    assert.equal(starts[0][0], folder);
    const configuration = starts[0][1];
    const provider = new BspDebugConfigurationProvider(() => assert.fail('Must not request a second endpoint'));
    assert.equal(await provider.resolveDebugConfiguration(folder, configuration), configuration);
    startResult = false;
    try { await assert.rejects(client.debug(target), /Failed to start VSCode debug session/); }
    finally { startResult = true; starts.length = 0; client.debugSessions.dispose(); }
});

for (const entry of ['toolbar', 'F5', 'prepare without token']) {
    test(`${entry} sends debug parameters as a JSON object`, { timeout: 5000 }, async () => {
        const requests = new PassThrough(), responses = new PassThrough();
        const connection = createMessageConnection(new StreamMessageReader(responses), new StreamMessageWriter(requests));
        const reader = new StreamMessageReader(requests), writer = new StreamMessageWriter(responses);
        const messages = [];
        const address = { uri: 'tcp://127.0.0.1:25000', data: { request: 'attach', pid: 42 } };
        reader.listen(message => {
            messages.push(message);
            void writer.write({ jsonrpc: '2.0', id: message.id, result: address });
        });
        connection.listen();
        const client = new BspClient(folder.uri, '/hello/.bsp/config.json', undefined, {
            getDebugInfo: () => ({}), canHandle: () => true,
            getRunArguments: async () => ['-configuration', 'Debug', '-destination', 'id=PHONE']
        });
        client.connection = connection;
        const target = { id: { uri: 'target://hello' }, displayName: 'Hello' };
        const cancellation = new CancellationTokenSource();
        try {
            if (entry === 'toolbar') {
                assert.deepEqual(await client.debug(target), address);
                assert.equal(starts.length, 1);
            } else if (entry === 'F5') {
                const provider = new BspDebugConfigurationProvider((_folder, token) => client.prepareDebugConfiguration(target, token));
                const config = await provider.resolveDebugConfiguration(folder,
                    { type: 'bsp-debug', request: 'launch', name: 'BSP Debug' }, cancellation.token);
                assert.equal(config.connect.port, 25000);
            } else {
                const config = await client.prepareDebugConfiguration(target);
                assert.equal(config.connect.port, 25000);
            }
            assert.equal(messages.length, 1);
            const message = messages[0];
            assert.equal(message.method, 'debugSession/start');
            assert.equal(Array.isArray(message.params), false, JSON.stringify(message.params));
            assert.equal(typeof message.params.originId, 'string');
            assert.deepEqual(message.params, {
                targets: [target.id], originId: message.params.originId,
                arguments: ['-configuration', 'Debug', '-destination', 'id=PHONE']
            });
        } finally {
            cancellation.dispose();
            client.debugSessions.dispose();
            connection.dispose();
            reader.dispose();
            writer.dispose();
            requests.destroy();
            responses.destroy();
            starts.length = 0;
        }
    });
}

test('cancelled selection does not open launch.json or create a debug session', async () => {
    const provider = new BspDebugConfigurationProvider(async () => undefined);
    assert.equal(await provider.resolveDebugConfiguration(folder, {}), null);
    const cancelled = new BspDebugConfigurationProvider(() => assert.fail('Cancelled request'));
    assert.equal(await cancelled.resolveDebugConfiguration(folder, {}, { isCancellationRequested: true }), null);
    await assert.rejects(provider.resolveDebugConfiguration(folder, { request: 'attach' }), /live DAP address/);
});

test('default configuration and schema are registered under contributes without a fixed port', () => {
    const manifest = require('../package.json');
    assert.equal(manifest.debuggers, undefined);
    const contribution = manifest.contributes.debuggers.find(entry => entry.type === 'bsp-debug');
    assert.equal(contribution.program, undefined);
    assert.ok(contribution.configurationAttributes.launch.properties.stopOnEntry);
    assert.ok(contribution.configurationAttributes.attach.properties.connect);
    const defaults = new BspDebugConfigurationProvider(async () => undefined).provideDebugConfigurations();
    assert.deepEqual(contribution.initialConfigurations, defaults);
    assert.equal(JSON.stringify(contribution).includes('5005'), false);
    assert.equal(JSON.stringify(contribution).includes('AskForProgramName'), false);
});
