const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { CancellationToken, CancellationTokenSource } = require('vscode-jsonrpc/node');
const { BuildContexts, buildContextExtension } = require('../out/buildContext');
const accepted = operations => ({ bspExtensions: { [buildContextExtension]: {
    version: '0.1', required: true, operations: operations ?? ['compile', 'run', 'test', 'debug']
} } });
const id = { uri: 'target://app' };
const target = { id, displayName: 'App', tags: [], languageIds: ['swift'], dependencies: [],
    capabilities: { canCompile: true, canRun: true, canTest: true, canDebug: true } };
const scope = { targets: [id] };
const dimension = (value = 'debug') => ({ id: 'provider.mode', label: 'Build mode', kind: 'enum', required: true,
    value, options: [{ id: 'debug', label: 'Debug' }, { id: 'release', label: 'Release' }] });
function options(value = {}) { return { dimensions: [dimension(value['provider.mode'] ?? 'debug')], selection: value }; }
function resolved(params) { return { id: 'context-' + params.operation, operation: params.operation,
    targets: params.scope.targets ?? [id], selection: params.selection }; }
function transport() {
    const requests = [];
    return { requests, async request(method, params) {
        requests.push({ method, params });
        return method === 'workspace/contextOptions' ? options(params.selection) : resolved(params);
    } };
}

test('negotiates only the supported private contract and requires strict execution', async () => {
    const server = transport(), contexts = new BuildContexts(server.request);
    for (const data of [undefined, { private: true }, { bspExtensions: { [buildContextExtension]: { version: '9' } } }]) {
        contexts.negotiate(data); assert.equal(contexts.enabled, false);
    }
    assert.throws(() => contexts.negotiate({ bspExtensions: { [buildContextExtension]: { version: '0.1' } } }), /invalid/);
    contexts.negotiate(accepted(['compile']));
    assert.equal(contexts.enabled, true);
    await assert.rejects(contexts.resolve(scope, 'run'), /does not support/);
    assert.equal(server.requests.length, 0);
    contexts.negotiate(accepted([]));
    assert.equal(contexts.enabled, true, 'An accepted empty operation set must not fall back to legacy requests');
    contexts.disconnect(); assert.equal(contexts.enabled, false);
});

test('persists explicit preferences by connection, workspace, target scope, and operation', async () => {
    const data = new Map(), storage = { get: key => data.get(key), update: async (key, value) => data.set(key, structuredClone(value)) };
    const create = identity => {
        const server = transport(), contexts = new BuildContexts(server.request);
        contexts.attachPreferences(storage, identity, 'file:///workspace'); contexts.negotiate(accepted());
        return contexts;
    };
    const contexts = create('config-A');
    await contexts.setSelection(scope, 'run', { 'provider.mode': 'release' });
    await contexts.options({}, 'compile');
    await contexts.resolve(scope, 'run');
    const restored = create('config-A');
    assert.deepEqual(restored.getSelection(scope, 'run'), { 'provider.mode': 'release' });
    assert.deepEqual(restored.getSelection({ ...scope, workspaceUri: 'file:///workspace' }, 'run'), { 'provider.mode': 'release' });
    for (const [s, op] of [[{}, 'run'], [scope, 'debug'], [{ ...scope, workspaceUri: 'file:///other' }, 'run']]) {
        assert.deepEqual(restored.getSelection(s, op), {});
    }
    assert.deepEqual(create('config-B').getSelection(scope, 'run'), {});
    const saved = JSON.stringify([...data.values()]);
    assert.doesNotMatch(saved, /context-run|debug/);
    assert.equal(Object.keys([...data.values()][0]).length, 1, 'Defaults and resolved IDs must not be saved');
});

test('all resolves reject unknown required kinds, absent choices, and unavailable values before execution', async () => {
    for (const changed of [
        { ...dimension(), kind: 'future-kind', options: undefined },
        { ...dimension(), value: undefined },
        { ...dimension(), value: 'missing' },
        { ...dimension(), options: [{ id: 'debug', label: 'Debug', availability: false, reason: 'Device unavailable' }] }
    ]) {
        const calls = [];
        const contexts = new BuildContexts(async method => {
            calls.push(method); return { dimensions: [changed], selection: {} };
        });
        contexts.negotiate(accepted());
        for (const operation of contexts.operations) {
            await assert.rejects(contexts.resolve(scope, operation), /Unsupported|Select|unavailable/);
        }
        assert.ok(calls.every(method => method === 'workspace/contextOptions'));
    }
});

test('resolve captures preferences before async discovery and propagates cancellation without fallback', async () => {
    let release;
    const calls = [], contexts = new BuildContexts(async (method, params, token) => {
        calls.push({ method, params, token });
        if (method === 'workspace/contextOptions') { return new Promise(resolve => { release = () => resolve(options(params.selection)); }); }
        return resolved(params);
    });
    contexts.negotiate(accepted());
    await contexts.setSelection(scope, 'run', { 'provider.mode': 'release' });
    const pending = contexts.resolve(scope, 'run');
    await contexts.setSelection(scope, 'run', { 'provider.mode': 'debug' });
    release(); await pending;
    assert.equal(calls[1].params.selection['provider.mode'], 'release');
    const source = new CancellationTokenSource();
    const cancelled = contexts.resolve(scope, 'run', source.token);
    source.cancel(); release(); await assert.rejects(cancelled, /cancelled/);
    assert.equal(calls.length, 3); assert.equal(calls[2].token, source.token);
});

class Emitter {
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    listeners = new Set(); fire(value) { for (const listener of this.listeners) { listener(value); } }
    dispose() { this.listeners.clear(); }
}
const notices = [], picks = [], starts = [];
const disposable = () => ({ dispose() {} });
const vscode = {
    EventEmitter: Emitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ThemeIcon: class { constructor(id) { this.id = id; } },
    ProgressLocation: { Notification: 15 },
    languages: { createDiagnosticCollection: () => ({ clear() {} }) },
    workspace: { getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }), getConfiguration: () => ({ get: () => undefined }) },
    debug: { onDidStartDebugSession: disposable, onDidTerminateDebugSession: disposable,
        startDebugging: async (_folder, config) => { starts.push(config); return true; } },
    window: {
        withProgress: (_options, action) => action({ report() {} }, CancellationToken.None),
        showInformationMessage: message => notices.push(message), showErrorMessage: message => notices.push(message),
        showWarningMessage: message => notices.push(message), setStatusBarMessage() {},
        showQuickPick: async items => { const pick = picks.shift(); assert.ok(pick, 'Unexpected picker'); return pick(items); }
    }
};
const load = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let BspClient, BuildContextProvider, ContextTreeItem;
try {
    ({ BspClient } = require('../out/bspClient'));
    ({ BuildContextProvider, ContextTreeItem } = require('../out/buildContextProvider'));
} finally { Module._load = load; }
function client(enabled = true) {
    const c = new BspClient({ fsPath: '/workspace', toString: () => 'file:///workspace' }, '/workspace/.bsp/server.json', undefined, {
        getDebugInfo: () => ({}), canHandle: () => true,
        getCompileArguments: async () => ['legacy-compile'], getRunArguments: async () => ['legacy-run'],
        getTestArguments: async () => ['legacy-test']
    });
    c.isConnected = true; c.buildTargets = [target];
    c.serverCapabilities = Object.fromEntries(['compile', 'run', 'test', 'debug'].map(op => [op + 'Provider', { languageIds: ['swift'] }]));
    c.requests = [];
    c.connection = {
        sendNotification() {},
        sendRequest: async (method, params, token) => {
            c.requests.push({ method, params, token });
            if (method === 'build/initialize') { return { capabilities: c.serverCapabilities, data: enabled ? accepted() : undefined }; }
            if (method === 'workspace/contextOptions') { return c.contextOptions ? c.contextOptions(params) : options(params.selection); }
            if (method === 'workspace/resolveContext') {
                if (c.resolveError) { throw c.resolveError; }
                return resolved(params);
            }
            if (method === 'debugSession/start') { return { uri: 'tcp://127.0.0.1:4711', data: { request: 'launch', program: '/app' } }; }
            return { statusCode: 1 };
        }
    };
    if (enabled) { c.contexts.negotiate(accepted()); }
    return c;
}

test('real client initialization offers the extension and keeps old servers on standard requests', async () => {
    for (const enabled of [false, true]) {
        const c = client(enabled); c.connectionDetails = { languages: ['swift'] };
        await c.initializeConnection();
        assert.deepEqual(c.requests[0].params.data, { bspExtensions: { [buildContextExtension]: { version: '0.1' } } });
        await c.compile(target);
        const compile = c.requests.at(-1);
        assert.equal(compile.method, 'buildTarget/compile');
        if (enabled) {
            assert.deepEqual(compile.params.executionContext, { id: 'context-compile' });
            assert.equal(compile.params.arguments, undefined);
        } else {
            assert.deepEqual(compile.params.arguments, ['legacy-compile']);
            assert.equal(compile.params.executionContext, undefined);
            assert.equal(c.requests.length, 2);
        }
    }
});

test('target actions, native test selections, and F5 send the operation context without legacy flags', async () => {
    const c = client(), events = []; c.onTestEvent(event => events.push(event));
    await c.contexts.setSelection(scope, 'run', { 'provider.mode': 'release' });
    await c.run(target);
    const run = c.requests.at(-1);
    assert.equal(run.method, 'buildTarget/run'); assert.deepEqual(run.params.target, id);
    assert.equal(run.params.executionContext.id, 'context-run'); assert.equal(run.params.arguments, undefined);
    assert.equal(c.requests.find(r => r.method === 'workspace/resolveContext').params.selection['provider.mode'], 'release');
    c.requests.length = 0;
    await c.test(target, { native: true, selection: { dataKind: 'test-cases', data: { ids: ['case-1'] } } });
    assert.deepEqual(c.requests.at(-1).params.data, { ids: ['case-1'] });
    assert.equal(c.requests.at(-1).params.dataKind, 'test-cases');
    assert.equal(c.requests.at(-1).params.executionContext.id, 'context-test');
    assert.deepEqual(events.map(event => event.kind), ['started', 'finished']);
    c.requests.length = 0;
    const debug = await c.prepareDebugConfiguration(target);
    assert.equal(debug.connect.port, 4711);
    assert.equal(c.requests.at(-1).method, 'debugSession/start');
    assert.equal(c.requests.at(-1).params.executionContext.id, 'context-debug');
    assert.deepEqual(c.requests[0].params.selection, {}, 'Run preferences must not become debug defaults');
    assert.ok(!c.requests.some(request => request.method === 'buildTarget/compile'));
    c.resolveError = new Error('Build context expired');
    c.requests.length = 0;
    await assert.rejects(c.run(target), /Build context expired/);
    assert.ok(c.requests.every(request => request.method.startsWith('workspace/')));
});

test('required unknown kinds block direct target, test, and debug entry points', async () => {
    const c = client();
    c.contextOptions = () => ({ dimensions: [{ ...dimension(), kind: 'future', options: undefined }], selection: {} });
    for (const action of [() => c.compile(target), () => c.run(target), () => c.test(target, { native: true }),
        () => c.debug(target), () => c.prepareDebugConfiguration(target), () => c.executeContext('run')]) {
        await assert.rejects(action(), /Unsupported configuration type/);
    }
    assert.ok(c.requests.every(request => request.method === 'workspace/contextOptions'));
});

function manager(clients) {
    const changes = new Emitter(), updates = new Emitter();
    const connections = clients.map((client, i) => ({ client, id: 'connection-' + i, connectionId: 'connection-' + i,
        connected: true, config: { name: 'Workspace ' + i, displayName: 'Workspace ' + i } }));
    return { onDidChangeConnections: changes.event, onDidUpdateTargets: updates.event,
        getConnectedClients: () => connections, connections };
}

test('workspace GUI shows all fields immediately, enables dependencies after Scheme, and does not preselect an operation', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c, client(false)]));
    c.contextOptions = params => {
        assert.equal(params.scope.targets, undefined);
        const selected = params.selection;
        const scheme = { id: 'xcode.scheme', label: 'Scheme', kind: 'enum', required: true,
            value: selected['xcode.scheme'], options: [{ id: 'A', label: 'App' }, { id: 'B', label: 'Other App' }] };
        if (selected['xcode.scheme'] === 'B') {
            assert.equal(selected['xcode.configuration'], undefined);
            assert.equal(selected['xcode.destination'], undefined);
        }
        return { selection: selected, dimensions: [scheme,
            { ...dimension(), id: 'xcode.configuration', label: 'Configuration', required: false,
                enabled: !!selected['xcode.scheme'], reason: selected['xcode.scheme'] ? undefined : 'Select Scheme first',
                options: selected['xcode.scheme'] ? dimension().options : [] },
            { id: 'xcode.destination', label: 'Destination', kind: 'enum', required: true,
                enabled: !!selected['xcode.scheme'], reason: selected['xcode.scheme'] ? undefined : 'Select Scheme first',
                value: selected['xcode.scheme'] ? 'host' : undefined,
                options: selected['xcode.scheme'] ? [{ id: 'host', label: 'Host' }] : [] }
        ] };
    };
    const roots = await provider.getChildren(); assert.equal(roots.length, 1);
    const shared = roots[0];
    let dimensions = await provider.getChildren(shared);
    assert.deepEqual(dimensions.map(item => item.label), ['Scheme', 'Configuration', 'Destination']);
    assert.equal(shared.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    for (const disabled of dimensions.slice(1)) {
        assert.equal(disabled.command, undefined);
        assert.equal(disabled.description, 'Select Scheme first');
        assert.equal(await provider.selectDimension(disabled), false);
    }
    picks.push(items => items.find(item => item.option?.id === 'A'));
    await provider.selectDimension(dimensions[0]);
    dimensions = await provider.getChildren(shared);
    assert.deepEqual(dimensions.map(item => item.label), ['Scheme', 'Configuration', 'Destination']);
    await c.contexts.setSelection({}, undefined, { 'xcode.scheme': 'A', 'xcode.configuration': 'release', 'xcode.destination': 'old' });
    picks.push(items => items.find(item => item.option?.id === 'B'));
    await provider.selectDimension(dimensions[0]);
    assert.deepEqual(c.contexts.getSelection({}, 'run'), { 'xcode.scheme': 'B' });
    assert.deepEqual(c.contexts.getSelection(scope, 'run'), {});
    assert.ok(c.requests.every(request => request.params.operation === undefined), 'Shared configuration must not preselect an operation');
    await provider.execute(shared, 'run');
    assert.equal(c.requests.at(-1).method, 'buildTarget/run');
    assert.deepEqual(c.requests.at(-1).params.target, id);
    provider.dispose();
});

test('target configuration stays separate from workspace and equal target IDs on other connections', async () => {
    const a = client(), b = client(), provider = new BuildContextProvider(manager([a, b]));
    picks.push(items => items.find(item => item.dimension));
    picks.push(items => items.find(item => item.option?.id === 'release'));
    picks.push(() => undefined);
    await provider.configure({ connectionId: 'connection-0', buildTarget: target });
    assert.deepEqual(a.contexts.getSelection(scope, 'run'), { 'provider.mode': 'release' });
    assert.deepEqual(a.contexts.getSelection({}, 'run'), {});
    assert.deepEqual(b.contexts.getSelection(scope, 'run'), {});
    const roots = await provider.getChildren(); assert.equal(roots.length, 3);
    const targetScope = roots.find(item => item.entry.scope.targets);
    await provider.getChildren(targetScope);
    assert.deepEqual(a.contexts.getSelection({}, 'run'), {}, 'Browsing must not change workspace choices');
    provider.dispose();
});

test('workspace execution locks all resolved targets and cancellation reaches the standard request', async () => {
    const c = client(), second = { uri: 'target://second' }, source = new CancellationTokenSource();
    const normal = c.connection.sendRequest;
    let started, finish;
    const sent = new Promise(resolve => { started = resolve; });
    c.connection.sendRequest = async (method, params, token) => {
        if (method === 'workspace/resolveContext') { return { ...resolved(params), targets: [id, second] }; }
        if (method === 'buildTarget/compile') {
            assert.deepEqual(params.targets, [id, second]);
            assert.equal(params.executionContext.id, 'context-compile');
            started(token);
            return new Promise(resolve => { finish = resolve; });
        }
        return normal(method, params, token);
    };
    const pending = c.executeContext('compile', {}, source.token);
    const token = await sent;
    for (const current of [id, second]) { assert.ok(c.operations.get(current.uri)); }
    await assert.rejects(c.compile({ ...target, id: second }), /Wait for the current operation/);
    source.cancel(); assert.equal(token.isCancellationRequested, true);
    for (const current of [id, second]) { assert.ok(c.operations.get(current.uri), 'Cancellation must retain the lock until the response'); }
    finish({ statusCode: 3 }); await pending;
    for (const current of [id, second]) { assert.equal(c.operations.get(current.uri), undefined); }
});

test('a stale target configuration command cannot select a different connection', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    await provider.configure({ connectionId: 'missing', buildTarget: target });
    assert.equal(c.requests.length, 0);
    assert.deepEqual(c.contexts.getSelection(scope, 'run'), {});
    provider.dispose();
});

test('legacy commands cannot promise to skip builds after execution contexts are negotiated', async () => {
    const c = client();
    await assert.rejects(c.runWithoutBuilding(target), /Use Run Target/);
    await assert.rejects(c.testWithoutBuilding(target), /Use Test Target/);
    assert.equal(c.requests.length, 0);
});

test('shared preferences are inherited while operation overrides stay explicit and defaults remain omitted', async () => {
    const server = transport(), contexts = new BuildContexts(server.request); contexts.negotiate(accepted());
    await contexts.setSelection(scope, undefined, { 'provider.mode': 'release' });
    assert.deepEqual(contexts.getSelection(scope, 'run'), { 'provider.mode': 'release' });
    assert.deepEqual(contexts.getSelection(scope, 'debug'), { 'provider.mode': 'release' });
    await contexts.setSelection(scope, 'debug', { 'provider.mode': 'debug' });
    assert.deepEqual(contexts.getSelection(scope, 'debug'), { 'provider.mode': 'debug' });
    await contexts.options(scope);
    assert.equal(Object.hasOwn(server.requests.at(-1).params, 'operation'), false);
    await contexts.choose(scope, 'provider.mode', undefined, [dimension()], 'debug');
    assert.deepEqual(contexts.getSelection(scope, 'debug'), {}, 'Automatic override omits the shared value from the wire');
    assert.deepEqual(contexts.getSelection(scope, 'run'), { 'provider.mode': 'release' });
    await contexts.reset(scope, 'debug');
    assert.deepEqual(contexts.getSelection(scope, 'debug'), { 'provider.mode': 'release' });
});

test('changing a shared upstream dimension clears dependent operation overrides but preserves upstream choices', async () => {
    const contexts = new BuildContexts(async (_method, params) => ({ dimensions: [], selection: params.selection }));
    contexts.negotiate(accepted());
    const dimensions = ['group', 'mode', 'device'].map(id => ({ ...dimension(), id, label: id }));
    await contexts.setSelection(scope, undefined, { group: 'A', mode: 'release', device: 'old' });
    await contexts.setSelection(scope, 'debug', { mode: 'debug', device: 'override', extra: 'old-session' });
    await contexts.choose(scope, 'device', 'new', dimensions);
    assert.deepEqual(contexts.getSelection(scope, 'debug'), { group: 'A', mode: 'debug', device: 'new' });
    await contexts.choose(scope, 'group', 'B', dimensions);
    assert.deepEqual(contexts.getSelection(scope, 'debug'), { group: 'B' });
    assert.deepEqual(contexts.getSelection(scope, 'run'), { group: 'B' });
});

test('custom server dimensions remain generic and action buttons use scope, server, and target capabilities', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => ({ selection: params.selection, operations: ['compile', 'run', 'test', 'debug'], dimensions: [
        { id: 'acme.profile', label: 'Optimization Profile', kind: 'enum', required: false,
            options: [{ id: 'size', label: 'Small binary' }, { id: 'speed', label: 'Fast binary' }] }
    ] });
    const workspace = (await provider.getChildren())[0];
    assert.match(workspace.contextValue, /canRun/);
    const rows = await provider.getChildren(workspace);
    assert.deepEqual(rows.map(item => item.label), ['Optimization Profile']);
    assert.equal(rows[0].operation, undefined);
    const limited = { ...target, capabilities: { canCompile: true, canTest: true, canRun: false, canDebug: false } };
    picks.push(() => undefined);
    await provider.configure({ connectionId: 'connection-0', buildTarget: limited });
    const scoped = (await provider.getChildren()).find(item => item.entry.scope.targets);
    assert.match(scoped.contextValue, /canCompile/); assert.match(scoped.contextValue, /canTest/);
    assert.doesNotMatch(scoped.contextValue, /canRun|canDebug/);
    await assert.rejects(provider.execute(scoped, 'run'), /does not support run/);
    delete c.serverCapabilities.debugProvider;
    assert.doesNotMatch((await provider.getChildren())[0].contextValue, /canDebug/);
    c.contextOptions = params => ({ dimensions: [], selection: params.selection, operations: ['compile'] });
    assert.doesNotMatch((await provider.getChildren())[0].contextValue, /canRun|canTest/);
    provider.dispose();
});

test('execution prompts for missing shared choices without operation-specific discovery', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => {
        assert.equal(Object.hasOwn(params, 'operation'), false);
        return { selection: params.selection, dimensions: [{
            id: 'acme.profile', label: 'Profile', kind: 'enum', required: true,
            options: [{ id: 'app', label: 'Application' }, { id: 'tests', label: 'Test Suite' }]
        }] };
    };
    const shared = (await provider.getChildren())[0];
    assert.deepEqual((await provider.getChildren(shared)).map(item => item.label), ['Profile']);
    picks.push(items => items.find(item => item.option?.id === 'tests'));
    await c.prepareDebugConfiguration(target);
    assert.equal(c.requests.at(-1).method, 'debugSession/start');
    assert.deepEqual(c.contexts.getSelection(scope), { 'acme.profile': 'tests' });
    assert.deepEqual(c.contexts.getSelection(scope, 'run'), { 'acme.profile': 'tests' });
    assert.equal(c.requests.find(request => request.method === 'workspace/resolveContext').params.operation, 'debug');
    await c.contexts.reset(scope); c.requests.length = 0;
    picks.push(() => undefined);
    await assert.rejects(c.run(target), /cancelled/);
    assert.ok(c.requests.every(request => request.method === 'workspace/contextOptions'));
    provider.dispose();
});

test('action buttons choose only the resolve operation and every options request omits it', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => {
        assert.equal(Object.hasOwn(params, 'operation'), false);
        return options(params.selection);
    };
    await c.contexts.setSelection({}, undefined, { 'provider.mode': 'release' });
    await c.contexts.setSelection({}, 'debug', { 'provider.mode': 'debug' });
    const root = (await provider.getChildren())[0];
    for (const operation of ['compile', 'run', 'test', 'debug']) {
        c.requests.length = 0;
        await provider.execute(root, operation);
        const resolutions = c.requests.filter(request => request.method === 'workspace/resolveContext');
        assert.equal(resolutions.length, 1);
        assert.equal(resolutions[0].params.operation, operation);
        assert.equal(resolutions[0].params.selection['provider.mode'], operation === 'debug' ? 'debug' : 'release');
        assert.equal(c.requests.at(-1).method, operation === 'debug' ? 'debugSession/start' : 'buildTarget/' + operation);
        assert.ok(c.requests.filter(request => request.method === 'workspace/contextOptions')
            .every(request => !Object.hasOwn(request.params, 'operation')));
    }
    provider.dispose();
});

test('disabled dimensions remain visible but cannot satisfy a required execution choice', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => ({ selection: params.selection, dimensions: [
        { id: 'vendor.destination', label: 'Destination', kind: 'enum', required: true,
            enabled: false, reason: 'No compatible devices', options: [] }
    ] });
    const root = (await provider.getChildren())[0], row = (await provider.getChildren(root))[0];
    assert.equal(row.label, 'Destination'); assert.equal(row.description, 'No compatible devices');
    assert.equal(row.command, undefined);
    await assert.rejects(c.run(target), /No compatible devices/);
    assert.ok(c.requests.every(request => request.method === 'workspace/contextOptions'));
    provider.dispose();
});

test('operation defaults returned by resolve never become saved shared choices', async () => {
    const calls = [], contexts = new BuildContexts(async (method, params) => {
        calls.push({ method, params });
        if (method === 'workspace/contextOptions') {
            assert.equal(Object.hasOwn(params, 'operation'), false);
            return { selection: {}, dimensions: [{ ...dimension(), required: false, value: undefined }] };
        }
        return { ...resolved(params), selection: { 'provider.mode': params.operation === 'run' ? 'release' : 'debug' } };
    });
    contexts.negotiate(accepted());
    assert.equal((await contexts.resolve(scope, 'run')).selection['provider.mode'], 'release');
    assert.equal((await contexts.resolve(scope, 'test')).selection['provider.mode'], 'debug');
    assert.deepEqual(contexts.getSelection(scope), {});
    assert.deepEqual(contexts.getSelection(scope, 'run'), {});
    assert.ok(calls.every(call => Object.keys(call.params.selection).length === 0));
});

const { destinationDetail, contextOptionDetail, contextOptionTooltip } = require('../out/buildContextPresentation');
const destination = (kind, extra = {}) => ({ id: kind, label: kind, description: 'Server description',
    dataKind: 'execution-destination', data: { kind, platform: { id: 'vendor-platform', label: 'Example OS' }, ...extra } });

test('destination metadata formats known types and valid platform, version, architecture, and state fields', () => {
    assert.equal(destinationDetail(destination('simulator', { osVersion: '18.2', architecture: 'arm64', state: 'booted' })),
        'Example OS 18.2 · Simulator · arm64 · State: booted');
    for (const kind of ['host', 'device', 'simulator', 'emulator', 'remote', 'container', 'generic']) {
        assert.ok(destinationDetail(destination(kind)).startsWith('Example OS · '));
    }
    assert.equal(destinationDetail(destination('host', { platform: undefined, osVersion: undefined, architecture: 'x86_64' })),
        'Host · x86_64');
    assert.equal(destinationDetail(destination('device', { platform: [], osVersion: 17, architecture: {}, state: [] })), 'Device');
    const offline = { ...destination('device'), availability: false, reason: 'Reconnect the device' };
    assert.match(contextOptionDetail(offline), /Example OS · Device\nReconnect the device/);
    assert.match(contextOptionTooltip(offline), /^Server description\n/);
});

test('unknown or absent destination metadata preserves plain labels and descriptions', () => {
    for (const option of [
        { ...destination('device'), dataKind: 'another-extension' }, destination('future-kind'), destination('__proto__'),
        { ...destination('host'), data: null }, { ...destination('host'), data: [] },
        { ...destination('host'), data: { platform: { id: 'custom', label: 'Custom' } } },
        { id: 'plain', label: 'Plain host', description: 'Server description' }
    ]) {
        assert.equal(destinationDetail(option), undefined);
        assert.equal(contextOptionDetail(option), undefined);
        assert.equal(contextOptionTooltip(option), 'Server description');
    }
});

test('tree and picker show destination metadata without deriving action capability or availability from its kind', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    const options = [destination('simulator', { osVersion: '18.2', architecture: 'arm64', state: 'booted' }),
        destination('generic'), { ...destination('device'), availability: false, reason: 'Reconnect the device' },
        destination('future-kind')];
    c.contextOptions = params => ({ selection: params.selection, dimensions: [{
        id: 'vendor.destination', label: 'Execution Host', kind: 'enum', required: true,
        value: params.selection['vendor.destination'] ?? 'simulator', options
    }] });
    const root = (await provider.getChildren())[0];
    let row = (await provider.getChildren(root))[0];
    assert.match(row.tooltip, /Example OS 18.2 · Simulator · arm64 · State: booted/);
    picks.push(items => {
        assert.match(items.find(item => item.option?.id === 'simulator').detail, /Example OS 18.2/);
        const unknown = items.find(item => item.option?.id === 'future-kind');
        assert.equal(unknown.label, 'future-kind'); assert.equal(unknown.description, 'Server description');
        assert.equal(unknown.detail, undefined);
        return items.find(item => item.option?.id === 'generic');
    });
    assert.equal(await provider.selectDimension(row), true);
    assert.equal(c.contexts.getSelection({})['vendor.destination'], 'generic');
    assert.match((await provider.getChildren())[0].contextValue, /canRun/);
    row = (await provider.getChildren(root))[0];
    assert.match(row.tooltip, /Generic/);
    picks.push(items => {
        const unavailable = items.find(item => item.option?.id === 'device');
        assert.match(unavailable.detail, /Device/); assert.match(unavailable.detail, /Reconnect the device/);
        return unavailable;
    });
    assert.equal(await provider.selectDimension(row), false);
    assert.equal(c.contexts.getSelection({})['vendor.destination'], 'generic');
    provider.dispose();
});
