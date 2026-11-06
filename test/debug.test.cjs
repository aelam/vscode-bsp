const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { PassThrough } = require('node:stream');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationToken, CancellationTokenSource } = require('vscode-jsonrpc/node');
const { debugConfiguration } = require('../out/debugConfiguration');

const starts = [];
const folder = { uri: { fsPath: '/hello' } };
let startResult = true;
let lldbInitCommands = [];
const vscode = {
    EventEmitter: class {
        listeners = new Set();
        event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
        fire(value) { for (const listener of this.listeners) { listener(value); } }
        dispose() { this.listeners.clear(); }
    },
    DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } },
    DebugAdapterServer: class { constructor(port, host) { Object.assign(this, { port, host }); } },
    DebugAdapterNamedPipeServer: class { constructor(path) { this.path = path; } },
    languages: { createDiagnosticCollection: () => ({}) },
    workspace: {
        getWorkspaceFolder: () => folder,
        getConfiguration: (section, resource) => {
            assert.equal(section, 'bsp.debug');
            assert.equal(resource, folder.uri);
            return { get: (key) => {
                assert.equal(key, 'lldbInitCommands');
                return lldbInitCommands;
            } };
        }
    },
    ProgressLocation: { Notification: 15 },
    window: {
        withProgress: (_options, action) => action({ report() {} }, CancellationToken.None),
        showErrorMessage() {}, showInformationMessage() {}
    },
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
    const launch = { request: 'launch', program: '/tmp/Hello', args: ['--filter', 'Tests', '/tmp/中文 tests'],
        env: { TEST_FILTER: 'Tests', EMPTY: '' }, cwd: '/tmp/中文 tests' };
    const unix = debugConfiguration({ uri: 'unix:///tmp/bsp%20debug.sock', data: launch }, 'Hello');
    assert.deepEqual(unix.connect, { socket: '/tmp/bsp debug.sock' });
    assert.equal(unix.request, 'launch');
    assert.equal(unix.program, '/tmp/Hello');
    assert.deepEqual(unix.args, launch.args);
    assert.deepEqual(unix.env, launch.env);
    assert.equal(unix.cwd, launch.cwd);
    unix.args.push('client-only');
    unix.env.EMPTY = 'client-only';
    assert.equal(launch.args.length, 3);
    assert.equal(launch.env.EMPTY, '');
    assert.deepEqual(debugConfiguration({ uri: 'tcp://[::1]:23456' }, 'Hello').connect, { host: '::1', port: 23456 });
});

test('rejects invalid endpoints without falling back to port 5005', () => {
    for (const uri of ['tcp://localhost', 'tcp://localhost:0', 'tcp://localhost:70000', 'http://localhost:5005', 'unix:///']) {
        assert.throws(() => debugConfiguration({ uri }, 'Hello'));
    }
});

test('workspace LLDB commands reach target actions and F5 with launch overrides', async () => {
    const client = new BspClient(folder.uri);
    const target = { id: { uri: 'target://hello' } };
    let dataKind = 'lldb';
    const requests = [];
    client.connection = { sendRequest: async (method, params) => {
        requests.push({ method, params });
        return {
            uri: 'tcp://127.0.0.1:25000', dataKind, data: { request: 'attach', pid: 42 }
        };
    } };
    lldbInitCommands = ['settings set symbols.enable-lldb-index-cache false'];
    const provider = new BspDebugConfigurationProvider((_folder, token) =>
        client.prepareDebugConfiguration(target, token));
    try {
        await client.debug(target);
        assert.equal(requests.at(-1).method, 'debugSession/start');
        assert.deepEqual(Object.keys(requests.at(-1).params).sort(), ['arguments', 'originId', 'targets']);
        assert.deepEqual(requests.at(-1).params.targets, [target.id]);
        assert.deepEqual(requests.at(-1).params.arguments, []);
        assert.equal(requests.at(-1).params.dataKind, undefined);
        assert.deepEqual(starts.at(-1)[1].initCommands, lldbInitCommands);
        const f5 = await provider.resolveDebugConfiguration(folder, { request: 'launch' });
        assert.deepEqual(f5.initCommands, lldbInitCommands);
        for (const override of [[], ['settings set target.preload-symbols false']]) {
            const config = await provider.resolveDebugConfiguration(folder,
                { request: 'launch', initCommands: override });
            assert.deepEqual(config.initCommands, override);
        }
        for (dataKind of ['other', undefined]) {
            assert.equal((await client.prepareDebugConfiguration(target)).initCommands, undefined);
        }
        dataKind = 'lldb';
        lldbInitCommands = ['valid', 42];
        await assert.rejects(client.prepareDebugConfiguration(target), /must be an array of strings/);
    } finally {
        lldbInitCommands = [];
        starts.length = 0;
        client.debugSessions.dispose();
    }
});

test('F5 prepares one BSP request and does not start a nested VS Code session', async () => {
    const client = new BspClient(folder.uri, '/hello/.bsp/config.json', undefined, {
        getDebugInfo: () => ({}), canHandle: () => true,
        getRunArguments: async () => ['-configuration', 'Debug', '-destination', 'id=PHONE']
    });
    const target = { id: { uri: 'target://hello' }, displayName: 'Hello' };
    const token = CancellationToken.None;
    let requests = 0;
    client.connection = { sendRequest: async (method, params, receivedToken) => {
        assert.equal(method, 'debugSession/start');
        assert.deepEqual(params.targets, [target.id]);
        assert.deepEqual(params.arguments, ['-configuration', 'Debug', '-destination', 'id=PHONE']);
        assert.equal(receivedToken.isCancellationRequested, false);
        assert.equal(typeof receivedToken.onCancellationRequested, 'function');
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
        assert.equal(descriptor.implementation.endpoint.port, port);
        descriptor.implementation.dispose();
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

test('test targets use the debug icon with test arguments and do not stop at entry', async () => {
    const client = new BspClient(folder.uri, undefined, undefined, {
        getDebugInfo: () => ({}), canHandle: () => true,
        getRunArguments: () => assert.fail('Test debugging must use test settings'),
        getTestArguments: async () => ['-configuration', 'Debug', '-destination', 'id=SIM']
    });
    const target = { id: { uri: 'target://tests' }, displayName: 'Tests', capabilities: { canTest: true, canDebug: true, canRun: false } };
    client.connection = { sendRequest: async (method, params) => {
        assert.equal(method, 'debugSession/start');
        assert.deepEqual(params.targets, [target.id]);
        assert.deepEqual(params.arguments, ['-configuration', 'Debug', '-destination', 'id=SIM']);
        return { uri: 'tcp://127.0.0.1:25001', data: { request: 'attach', pid: 1234 } };
    } };
    try {
        for (const start of [client.debug.bind(client), client.debugTests.bind(client)]) {
            await start(target);
            assert.equal(starts.at(-1)[1].stopOnEntry, false);
            assert.equal(starts.at(-1)[1].request, 'attach');
            assert.equal(starts.at(-1)[1].pid, 1234);
            assert.match(starts.at(-1)[1].name, /Debug Tests/);
        }
        const provider = new BspDebugConfigurationProvider(() => client.prepareDebugConfiguration(target));
        const f5 = await provider.resolveDebugConfiguration(folder,
            { type: 'bsp-debug', request: 'launch', name: 'Tests', stopOnEntry: true });
        assert.equal(f5.stopOnEntry, false);
        await assert.rejects(client.debugTests({ ...target, capabilities: { canTest: true, canDebug: false } }), /does not support/);
        const manifest = require('../package.json');
        const menus = manifest.contributes.menus['view/item/context'];
        assert.equal(menus.some(m => m.command === 'bsp.debugTests'), false);
        const icon = menus.find(m => m.command === 'bsp.debug');
        assert.match(icon.group, /inline/);
        assert.match(icon.when, /canDebug/);
        assert.match(icon.when, /busy/);
        assert.doesNotMatch(icon.when, /canCompile/);
        const withoutBuilding = menus.find(m => m.command === 'bsp.debugWithoutBuilding');
        assert.equal(manifest.contributes.commands.find(c => c.command === 'bsp.debugWithoutBuilding').title, 'Debug Without Building');
        assert.match(withoutBuilding.group, /advanced/);
        assert.match(withoutBuilding.when, /canDebug/);
        assert.match(withoutBuilding.when, /busy/);
        assert.doesNotMatch(withoutBuilding.when, /canCompile/);
        client.buildSystemManager.getTestArguments = async () => { throw new Error('Invalid test destination'); };
        await assert.rejects(client.debug(target), /Invalid test destination/);
    } finally { client.debugSessions.dispose(); starts.length = 0; }
});


for (const action of ['compile', 'debugTests']) {
    test(`${action} forwards cancellation from Testing and releases the target`, async () => {
        const client = new BspClient(folder.uri), source = new CancellationTokenSource();
        const target = { id: { uri: 'target://tests' }, capabilities: { canTest: true, canDebug: true } };
        let receivedToken, started;
        const ready = new Promise(resolve => { started = resolve; });
        client.connection = { sendRequest: (_method, _params, token) => new Promise((_resolve, reject) => {
            receivedToken = token;
            token.onCancellationRequested(() => reject(new Error('Cancelled by Testing')));
            started();
        }) };
        try {
            const pending = client[action](target, source.token);
            const rejected = assert.rejects(pending, /Cancelled by Testing/);
            await ready; source.cancel(); await rejected;
            assert.equal(receivedToken.isCancellationRequested, true);
            assert.equal(starts.length, 0);
            assert.equal(client.getActiveRequests().size, 0);
            assert.equal(client.operations.get(target.id.uri), undefined);
            client.connection.sendRequest = async () => action === 'compile' ? { statusCode: 1 }
                : { uri: 'tcp://127.0.0.1:25001', data: { request: 'attach', pid: 1234 } };
            await client[action](target);
            assert.equal(starts.length, action === 'debugTests' ? 1 : 0);
        } finally { source.dispose(); client.debugSessions.dispose(); starts.length = 0; }
    });
}
