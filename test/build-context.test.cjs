const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { CancellationToken, CancellationTokenSource } = require('vscode-jsonrpc/node');
const { BuildContexts, buildContextExtension } = require('../out/buildContext');
const accepted = (operations, buildPolicies) => ({ bspExtensions: { [buildContextExtension]: {
    version: '0.1', required: true, operations: operations ?? ['compile', 'run', 'test', 'debug'],
    ...(buildPolicies === undefined ? {} : { buildPolicies })
} } });
const id = { uri: 'target://app' };
const target = { id, displayName: 'App', tags: [], languageIds: ['swift'], dependencies: [],
    capabilities: { canCompile: true, canRun: true, canTest: true, canDebug: true } };
const scope = { targets: [id] };
const dimension = (value = 'debug') => ({ id: 'provider.mode', label: 'Build mode', kind: 'enum', required: true,
    value, options: [{ id: 'debug', label: 'Debug' }, { id: 'release', label: 'Release' }] });
function options(value = {}) { return { dimensions: [dimension(value['provider.mode'] ?? 'debug')], selection: value }; }
function resolved(params) { return { id: 'context-' + params.operation, operation: params.operation,
    targets: params.scope.targets ?? [id], selection: params.selection,
    ...(params.buildPolicy === undefined ? {} : { buildPolicy: params.buildPolicy }) }; }
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

test('persists shared preferences by connection, workspace, and target scope', async () => {
    const data = new Map(), storage = { get: key => data.get(key), update: async (key, value) => data.set(key, structuredClone(value)) };
    const create = identity => {
        const server = transport(), contexts = new BuildContexts(server.request);
        contexts.attachPreferences(storage, identity, 'file:///workspace'); contexts.negotiate(accepted());
        return contexts;
    };
    const contexts = create('config-A');
    await contexts.setSelection(scope, { 'provider.mode': 'release' });
    await contexts.options({});
    await contexts.resolve(scope, 'run');
    const restored = create('config-A');
    assert.deepEqual(restored.getSelection(scope), { 'provider.mode': 'release' });
    assert.deepEqual(restored.getSelection({ ...scope, workspaceUri: 'file:///workspace' }), { 'provider.mode': 'release' });
    for (const other of [{}, { ...scope, workspaceUri: 'file:///other' }]) {
        assert.deepEqual(restored.getSelection(other), {});
    }
    assert.deepEqual(create('config-B').getSelection(scope), {});
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
    await contexts.setSelection({}, { 'provider.mode': 'release' });
    const pending = contexts.resolve({}, 'run');
    await contexts.setSelection({}, { 'provider.mode': 'debug' });
    release(); await pending;
    assert.equal(calls[1].params.selection['provider.mode'], 'release');
    const source = new CancellationTokenSource();
    const cancelled = contexts.resolve({}, 'run', source.token);
    source.cancel(); release(); await assert.rejects(cancelled, /cancelled/);
    assert.equal(calls.length, 3); assert.equal(calls[2].token, source.token);
});

class Emitter {
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    listeners = new Set(); fire(value) { for (const listener of this.listeners) { listener(value); } }
    dispose() { this.listeners.clear(); }
}
const notices = [], picks = [], starts = [], quickPicks = [];
const disposable = () => ({ dispose() {} });
const vscode = {
    EventEmitter: Emitter, ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ThemeIcon: class { constructor(id) { this.id = id; } },
    QuickPickItemKind: { Separator: -1 },
    ProgressLocation: { Notification: 15 },
    languages: { createDiagnosticCollection: () => ({ clear() {} }) },
    workspace: { getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }), getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }) },
    debug: { onDidStartDebugSession: disposable, onDidTerminateDebugSession: disposable,
        startDebugging: async (_folder, config) => { starts.push(config); return true; } },
    window: {
        withProgress: (_options, action) => action({ report() {} }, CancellationToken.None),
        showInformationMessage: message => notices.push(message), showErrorMessage: message => notices.push(message),
        showWarningMessage: message => notices.push(message), setStatusBarMessage() {},
        showQuickPick: async items => { const pick = picks.shift(); assert.ok(pick, 'Unexpected picker'); return pick(items); },
        createQuickPick: () => {
            const accepted = new Emitter(), hidden = new Emitter();
            const picker = { items: [], activeItems: [], selectedItems: [], disposed: false,
                onDidAccept: accepted.event, onDidHide: hidden.event,
                dispose() { this.disposed = true; accepted.dispose(); hidden.dispose(); },
                show() {
                    quickPicks.push(picker);
                    queueMicrotask(() => {
                        const pick = picks.shift(); assert.ok(pick, 'Unexpected picker');
                        const selected = pick(picker.items, picker);
                        if (selected) { picker.selectedItems = [selected]; accepted.fire(); }
                        else { hidden.fire(); }
                    });
                }
            };
            return picker;
        }
    }
};
const load = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let BspClient, BuildContextProvider, ContextTreeItem, MultiBspProvider;
try {
    ({ BspClient } = require('../out/bspClient'));
    ({ BuildContextProvider, ContextTreeItem } = require('../out/buildContextProvider'));
    ({ MultiBspProvider } = require('../out/multiBspProvider'));
} finally { Module._load = load; }
function client(enabled = true) {
    const c = new BspClient({ fsPath: '/workspace', toString: () => 'file:///workspace' }, '/workspace/.bsp/server.json');
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
            assert.deepEqual(compile.params.arguments, []);
            assert.equal(compile.params.executionContext, undefined);
            assert.equal(c.requests.length, 2);
        }
    }
});

test('standard target actions ignore retired selectors and preserve test selections', async () => {
    const c = client(false);
    const selected = { ...target, dataKind: 'sourceKit', data: {
        selectors: [{ keyName: 'Configuration', values: [{ displayName: 'Release', arguments: ['-configuration', 'Release'] }] }],
        selectedValues: { Configuration: { arguments: ['-configuration', 'Release'] } }
    } };
    const selection = { dataKind: 'test-cases', data: { ids: ['case-1'] } };
    for (const operation of ['compile', 'run', 'test', 'debug']) {
        c.requests.length = 0;
        if (operation === 'test') { await c.test(selected, { native: true, selection }); }
        else if (operation === 'debug') { await c.prepareDebugConfiguration(selected); }
        else { await c[operation](selected); }
        assert.equal(c.requests.length, 1);
        const { method, params } = c.requests[0];
        assert.equal(method, operation === 'debug' ? 'debugSession/start' : `buildTarget/${operation}`);
        assert.deepEqual(params.arguments, []);
        assert.equal(params.executionContext, undefined);
        if (operation === 'test') {
            assert.equal(params.dataKind, selection.dataKind);
            assert.deepEqual(params.data, selection.data);
        }
    }
    c.debugSessions.dispose();
});

test('target actions, native test selections, and F5 send the operation context without legacy flags', async () => {
    const c = client(), events = []; c.onTestEvent(event => events.push(event));
    await c.contexts.setSelection({}, { 'provider.mode': 'release' });
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
    const changes = new Emitter(), updates = new Emitter(), operations = new Emitter(), background = new Emitter();
    for (const client of clients) { client.operations.onDidChange(() => operations.fire()); }
    const connections = clients.map((client, i) => ({ client, id: 'connection-' + i, connectionId: 'connection-' + i,
        connected: true, config: { name: 'Workspace ' + i, displayName: 'Workspace ' + i } }));
    return { onDidChangeConnections: changes.event, onDidUpdateTargets: updates.event,
        onDidChangeOperations: operations.event, onDidChangeBackgroundTasks: background.event,
        getAllConnections: () => connections, getConnection: id => connections.find(connection => connection.id === id),
        getConnectedClients: () => connections.filter(connection => connection.connected), connections, changes, updates };
}

test('workspace GUI shows all fields immediately, enables dependencies after Scheme, and does not preselect an operation', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c, client(false)]));
    c.contextOptions = params => {
        assert.equal(params.scope.targets, undefined);
        const selected = params.selection;
        const scheme = { id: 'xcode.scheme', label: 'Scheme', kind: 'enum', required: true,
            value: selected['xcode.scheme'], options: [{ id: 'A', label: 'App' }, { id: 'B', label: 'Other App' }] };
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
    await c.contexts.setSelection({}, { 'xcode.scheme': 'A', 'xcode.configuration': 'release', 'xcode.destination': 'old' });
    picks.push(items => items.find(item => item.option?.id === 'B'));
    await provider.selectDimension(dimensions[0]);
    assert.deepEqual(c.contexts.getSelection({}), { 'xcode.scheme': 'B', 'xcode.configuration': 'release' });
    assert.deepEqual(c.contexts.getSelection(scope), {});
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
    assert.deepEqual(a.contexts.getSelection(scope), { 'provider.mode': 'release' });
    assert.deepEqual(a.contexts.getSelection({}), {});
    assert.deepEqual(b.contexts.getSelection(scope), {});
    const roots = await provider.getChildren(); assert.equal(roots.length, 2);
    assert.ok(roots.every(item => !item.entry.scope.targets));
    await provider.getChildren(roots[0]);
    assert.deepEqual(a.contexts.getSelection({}), {}, 'Browsing must not change workspace choices');
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
    assert.deepEqual(c.contexts.getSelection(scope), {});
    provider.dispose();
});

test('without-building actions reject unsupported policies before preparation or requests', async () => {
    const c = client();
    c.prepareExecutionContext = async () => { assert.fail('Unsupported reuse must not open configuration'); };
    for (const action of [() => c.runWithoutBuilding(target), () => c.testWithoutBuilding(target),
        () => c.debugWithoutBuilding(target)]) {
        await assert.rejects(action(), /does not support execution without building/);
        assert.equal(c.operations.get(id.uri), undefined);
    }
    c.contexts.negotiate(accepted(undefined, ['build', 'reuse']));
    await assert.rejects(c.executeContext('compile', scope, undefined, {}, true, [], 'reuse'), /not supported for compile/);
    assert.equal(c.requests.length, 0);
});

test('saved operation overrides cannot affect shared selections or execution', async () => {
    const workspaceUri = 'file:///workspace', storageKey = 'bsp.contextPreferences.v1:config-A';
    const shared = { 'xcode.scheme': 'Shared', 'xcode.configuration': 'Debug', 'xcode.destination': 'device' };
    const saved = {
        [JSON.stringify([workspaceUri, null, null])]: shared,
        [JSON.stringify([workspaceUri, [id.uri], null])]: { 'target.runtime': 'shared-runtime' }
    };
    for (const operation of ['compile', 'run', 'test', 'debug']) {
        for (const targets of [null, [id.uri]]) {
            saved[JSON.stringify([workspaceUri, targets, operation])] = {
                'xcode.scheme': 'Old', 'xcode.configuration': null, 'xcode.destination': 'old-device', 'target.runtime': 'old-runtime'
            };
        }
    }
    const data = new Map([[storageKey, saved]]), requests = [];
    const contexts = new BuildContexts(async (method, params) => {
        requests.push({ method, params });
        if (method !== 'workspace/contextOptions') { return resolved(params); }
        const values = { ...shared, ...(params.scope.targets ? { 'target.runtime': 'shared-runtime' } : {}) };
        return { selection: params.selection, dimensions: Object.entries(values).map(([id, value]) => ({
            id, label: id, kind: 'enum', required: false, options: [{ id: value, label: value }]
        })) };
    });
    contexts.attachPreferences({ get: key => data.get(key), update: async (key, value) => data.set(key, structuredClone(value)) },
        'config-A', workspaceUri);
    contexts.negotiate(accepted(undefined, ['build', 'reuse']));
    assert.deepEqual(contexts.getSelection({}), shared);
    assert.deepEqual(contexts.getSelection(scope), { 'target.runtime': 'shared-runtime' });
    for (const operation of contexts.operations) {
        for (const currentScope of [{}, scope]) {
            for (const policy of operation === 'compile' ? ['build'] : ['build', 'reuse']) {
                const result = await contexts.resolve(currentScope, operation, CancellationToken.None, policy);
                assert.deepEqual(result.selection, { ...shared, ...(currentScope.targets ? { 'target.runtime': 'shared-runtime' } : {}) });
                assert.equal(result.operation, operation);
                assert.equal(result.buildPolicy ?? 'build', policy);
            }
        }
    }
    assert.ok(requests.filter(request => request.method === 'workspace/contextOptions')
        .every(request => !Object.hasOwn(request.params, 'operation')));
    await contexts.setSelection({}, shared);
    assert.ok(Object.keys(data.get(storageKey)).every(key => JSON.parse(key)[2] === null), 'Saving removes legacy operation records');
});

test('legacy operation selections do not replace Automatic defaults', async () => {
    const server = transport(), contexts = new BuildContexts(server.request);
    const saved = Object.fromEntries(['compile', 'run', 'test', 'debug'].map(operation => [
        JSON.stringify(['file:///workspace', null, operation]), { 'provider.mode': 'release' }
    ]));
    contexts.attachPreferences({ get: () => saved, update: async () => {} }, 'config-A', 'file:///workspace');
    contexts.negotiate(accepted());
    for (const operation of contexts.operations) {
        assert.deepEqual((await contexts.resolve({}, operation)).selection, {});
    }
    assert.deepEqual(contexts.getSelection({}), {});
});

test('changing shared choices retains compatible selections and removes obsolete fields', async () => {
    const contexts = new BuildContexts(async (_method, params) => dependencyOptions(params.selection));
    contexts.negotiate(accepted());
    const dimensions = dependencyOptions({ group: 'A' }).dimensions;
    await contexts.setSelection(scope, { group: 'A', mode: 'release', device: 'one', extra: 'old-session' });
    await contexts.choose(scope, 'device', 'two', dimensions);
    assert.deepEqual(contexts.getSelection(scope), { group: 'A', mode: 'release', device: 'two' });
    await contexts.choose(scope, 'group', 'B', dimensions);
    assert.deepEqual(contexts.getSelection(scope), { group: 'B', mode: 'release', device: 'two' });
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
    const limited = { ...target, capabilities: { canCompile: true, canTest: true, canRun: false, canDebug: false } };
    picks.push(() => undefined);
    await provider.configure({ connectionId: 'connection-0', buildTarget: limited });
    assert.equal((await provider.getChildren()).length, 1);
    const scoped = new ContextTreeItem({ ...workspace.entry, target: limited, scope: { targets: [limited.id] } });
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
    assert.deepEqual(c.contexts.getSelection({}), { 'acme.profile': 'tests' });
    assert.equal(c.requests.find(request => request.method === 'workspace/resolveContext').params.operation, 'debug');
    await c.contexts.reset({}); c.requests.length = 0;
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
    await c.contexts.setSelection({}, { 'provider.mode': 'release' });
    const root = (await provider.getChildren())[0];
    for (const operation of ['compile', 'run', 'test', 'debug']) {
        c.requests.length = 0;
        await provider.execute(root, operation);
        const resolutions = c.requests.filter(request => request.method === 'workspace/resolveContext');
        assert.equal(resolutions.length, 1);
        assert.equal(resolutions[0].params.operation, operation);
        assert.equal(resolutions[0].params.selection['provider.mode'], 'release');
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
    assert.ok(calls.every(call => Object.keys(call.params.selection).length === 0));
});

const { destinationDetail, contextOptionDetail, contextOptionTooltip,
    contextOptionPresentation, contextOptionGroups } = require('../out/buildContextPresentation');
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
        assert.match(items.find(item => item.option?.id === 'simulator').description, /Example OS.*18.2/);
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
        assert.match(unavailable.detail, /Reconnect the device/);
        return unavailable;
    });
    assert.equal(await provider.selectDimension(row), false);
    assert.equal(c.contexts.getSelection({})['vendor.destination'], 'generic');
    provider.dispose();
});

test('selection reuses validated options and refreshes only its scope', async () => {
    const a = client(), b = client(), connections = manager([a, b]);
    const provider = new BuildContextProvider(connections), changed = [];
    provider.onDidChangeTreeData(item => changed.push(item));
    const roots = await provider.getChildren();
    const rows = await Promise.all(roots.map(root => provider.getChildren(root)));
    assert.deepEqual([a.requests.length, b.requests.length], [1, 1]);
    a.requests.length = 0; b.requests.length = 0;
    picks.push(items => items.find(item => item.option?.id === 'release'));
    await provider.selectDimension(rows[0][0]);
    assert.deepEqual(changed, [roots[0]]);
    assert.deepEqual([a.requests.length, b.requests.length], [2, 0]);
    assert.equal((await provider.getChildren(roots[0]))[0].description, 'Release');
    await provider.getChildren(roots[1]);
    assert.deepEqual([a.requests.length, b.requests.length], [2, 0]);
    connections.updates.fire('connection-0');
    assert.equal(changed.at(-1), undefined);
    const refreshed = await provider.getChildren();
    await Promise.all(refreshed.map(root => provider.getChildren(root)));
    assert.deepEqual([a.requests.length, b.requests.length], [3, 1]);
    provider.dispose();
});

test('a picker focuses the current value without saving focus changes', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    await c.contexts.setSelection({}, { 'provider.mode': 'release' });
    const root = (await provider.getChildren())[0], row = (await provider.getChildren(root))[0];
    c.requests.length = 0;
    picks.push((items, picker) => {
        assert.equal(picker.activeItems[0].option.id, 'release');
        picker.activeItems = [items.find(item => item.option?.id === 'debug')];
        return undefined;
    });
    assert.equal(await provider.selectDimension(row), false);
    assert.deepEqual(c.contexts.getSelection({}), { 'provider.mode': 'release' });
    assert.equal(c.requests.length, 1);
    assert.equal(quickPicks.at(-1).disposed, true);
    provider.dispose();
});

test('required choices show Not selected and do not offer Automatic', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => ({ selection: params.selection, dimensions: [{ ...dimension(), value: undefined }] });
    const root = (await provider.getChildren())[0], row = (await provider.getChildren(root))[0];
    assert.equal(row.description, 'Not selected');
    picks.push(items => {
        assert.ok(items.every(item => item.label !== 'Automatic'));
        return undefined;
    });
    assert.equal(await provider.selectDimension(row), false);
    provider.dispose();
});

test('Automatic clears its field, keeps compatible dependent choices, and resolves defaults when execution starts', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => ({ selection: params.selection, dimensions: [
        { ...dimension(), required: false, value: params.selection['provider.mode'] },
        { ...dimension(), id: 'provider.device', label: 'Device', required: false, value: params.selection['provider.device'] }
    ] });
    await c.contexts.setSelection({}, { 'provider.mode': 'release', 'provider.device': 'release' });
    const root = (await provider.getChildren())[0];
    picks.push((items, picker) => {
        assert.equal(picker.activeItems[0].option.id, 'release');
        const automatic = items.find(item => item.label === 'Automatic');
        assert.match(automatic.detail, /operation starts/);
        return automatic;
    });
    await provider.selectDimension((await provider.getChildren(root))[0]);
    assert.deepEqual(c.contexts.getSelection({}), { 'provider.device': 'release' });
    const automatic = (await provider.getChildren(root))[0];
    assert.equal(automatic.description, 'Automatic');
    picks.push((_items, picker) => {
        assert.equal(picker.activeItems[0].label, 'Automatic');
        return undefined;
    });
    await provider.selectDimension(automatic);
    const send = c.connection.sendRequest;
    c.connection.sendRequest = async (method, params, token) => {
        const result = await send(method, params, token);
        if (method === 'workspace/resolveContext') {
            assert.deepEqual(params.selection, { 'provider.device': 'release' });
            return { ...result, selection: { 'provider.mode': params.operation === 'run' ? 'release' : 'debug' } };
        }
        return result;
    };
    assert.equal((await c.contexts.resolve({}, 'run')).selection['provider.mode'], 'release');
    assert.equal((await c.contexts.resolve({}, 'debug')).selection['provider.mode'], 'debug');
    assert.deepEqual(c.contexts.getSelection({}), { 'provider.device': 'release' });
    provider.dispose();
});

test('shared selection updates refresh the tree and apply to every operation', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    await c.contexts.setSelection({}, { 'provider.mode': 'release' });
    const root = (await provider.getChildren())[0], row = (await provider.getChildren(root))[0];
    const changed = []; provider.onDidChangeTreeData(item => changed.push(item));
    picks.push(items => items.find(item => item.option?.id === 'debug'));
    await provider.selectDimension(row);
    assert.deepEqual(changed, [root]);
    assert.equal((await provider.getChildren(root))[0].description, 'Debug');
    assert.deepEqual(c.contexts.getSelection({}), { 'provider.mode': 'debug' });
    for (const operation of c.contexts.operations) {
        assert.deepEqual((await c.contexts.resolve({}, operation)).selection, { 'provider.mode': 'debug' });
    }
    provider.dispose();
});

test('structured destinations keep generic choices in a final group and avoid repeated metadata', () => {
    const host = { ...destination('host'), id: 'host', label: 'This Mac' };
    const generic = destination('generic');
    const simulator = { ...destination('simulator', { osVersion: '18.2', state: 'booted' }), label: 'Phone Simulator' };
    const offline = { ...destination('device'), id: 'offline', availability: false, reason: 'Reconnect the device' };
    const unknown = destination('future-kind');
    const groups = contextOptionGroups([generic, simulator, offline, host, unknown]);
    assert.deepEqual(groups.map(group => group.label), ['Devices', 'Simulators', 'Other destinations', 'Generic destinations']);
    assert.deepEqual(groups[0].options, [host, offline]);
    assert.deepEqual(groups[1].options, [simulator]);
    assert.deepEqual(groups[2].options, [unknown]);
    assert.deepEqual(groups.at(-1).options, [generic]);
    const presentation = contextOptionPresentation(simulator);
    assert.equal(presentation.label, 'Phone Simulator');
    assert.match(presentation.description, /Example OS.*18.2/);
    assert.doesNotMatch(presentation.description, /Simulator/);
    assert.equal(presentation.detail, 'Server description · State: booted');
    assert.equal(presentation.icon, 'vm');
    assert.equal(contextOptionPresentation({ ...simulator, description: destinationDetail(simulator) }).detail, 'State: booted');
    assert.deepEqual(contextOptionPresentation(unknown), {
        label: unknown.label, description: unknown.description, detail: undefined
    });
    assert.match(contextOptionPresentation(offline).detail, /Reconnect/);
});

test('configuration lists contain only fields and reset, and reuse a completed choice', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    picks.push(items => {
        assert.ok(items.every(item => item.action === 'dimension' || item.action === 'reset'));
        assert.ok(items.every(item => !item.label.startsWith('Execute ')));
        return items.find(item => item.dimension);
    });
    picks.push(items => items.find(item => item.option?.id === 'release'));
    picks.push(items => {
        assert.equal(items.find(item => item.dimension).description, 'Release');
        assert.ok(items.every(item => item.action !== 'execute'));
        return undefined;
    });
    await provider.configure();
    assert.equal(c.requests.length, 3);
    assert.ok(c.requests.every(request => request.method === 'workspace/contextOptions'));
    provider.dispose();
});

test('target configuration stays outside workspace roots and keeps connection preferences separate', async () => {
    const a = client(), b = client(), provider = new BuildContextProvider(manager([a, b]), a);
    const initial = await provider.getChildren();
    assert.equal(initial.length, 2, 'The legacy alias must not duplicate a managed connection');
    assert.ok(initial.every(item => item.label.includes('Workspace')));
    const changed = []; provider.onDidChangeTreeData(item => changed.push(item));
    for (let index = 0; index < 2; index++) {
        picks.push(items => items.find(item => item.dimension));
        picks.push(items => items.find(item => item.option?.id === 'release'));
        picks.push(() => undefined);
        await provider.configure({ connectionId: 'connection-0', buildTarget: target });
    }
    assert.equal((await provider.getChildren()).length, 2);
    assert.deepEqual(changed, [], 'Target preferences must not refresh the workspace tree');
    assert.deepEqual(a.contexts.getSelection(scope), { 'provider.mode': 'release' });
    assert.deepEqual(a.contexts.getSelection({}), {});
    assert.deepEqual(b.contexts.getSelection(scope), {});
    picks.push(items => items.find(item => item.dimension));
    picks.push(items => items.find(item => item.option?.id === 'debug'));
    picks.push(() => undefined);
    await provider.configure({ connectionId: 'connection-1', buildTarget: target });
    const otherTarget = { ...target, id: { uri: 'target://other' }, displayName: 'Other' };
    picks.push(() => undefined);
    await provider.configure({ connectionId: 'connection-0', buildTarget: otherTarget });
    const roots = await provider.getChildren();
    assert.equal(roots.length, 2);
    assert.equal(new Set(roots.map(item => item.id)).size, 2);
    assert.equal(roots[0], initial[0]);
    assert.deepEqual(a.contexts.getSelection(scope), { 'provider.mode': 'release' });
    assert.deepEqual(b.contexts.getSelection(scope), { 'provider.mode': 'debug' });
    assert.deepEqual(a.contexts.getSelection({ targets: [otherTarget.id] }), {});
    provider.dispose();
});

test('late discovery cannot overwrite a newer choice or trigger another request', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    const root = (await provider.getChildren())[0], row = (await provider.getChildren(root))[0];
    let release;
    c.contextOptions = params => new Promise(resolve => { release = () => resolve(options(params.selection)); });
    const stale = provider.getChildren();
    c.contextOptions = params => options(params.selection);
    picks.push(items => items.find(item => item.option?.id === 'release'));
    await provider.selectDimension(row);
    const beforeRelease = c.requests.length;
    release(); await stale;
    assert.equal((await provider.getChildren(root))[0].description, 'Release');
    assert.equal(c.requests.length, beforeRelease);
    assert.deepEqual(c.contexts.getSelection({}), { 'provider.mode': 'release' });
    provider.dispose();
});

test('refresh invalidates a pending snapshot even when preferences do not change', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    const root = (await provider.getChildren())[0];
    let release;
    c.contextOptions = params => new Promise(resolve => { release = () => resolve(options(params.selection)); });
    const stale = provider.getChildren();
    provider.refresh();
    c.contextOptions = params => ({ ...options(params.selection), operations: ['compile'],
        dimensions: [{ ...dimension(), label: 'Updated mode' }] });
    const fresh = await provider.getChildren();
    const beforeRelease = c.requests.length;
    release(); await stale;
    assert.equal(fresh[0], root);
    assert.equal((await provider.getChildren(root))[0].label, 'Updated mode');
    assert.doesNotMatch(root.contextValue, /canRun|canTest|canDebug/);
    assert.equal(c.requests.length, beforeRelease);
    provider.dispose();
});

test('required defaults returned in selection appear consistently in trees and configuration lists', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = () => ({ selection: { 'provider.mode': 'release' }, dimensions: [{ ...dimension(), value: undefined }] });
    const root = (await provider.getChildren())[0];
    assert.equal((await provider.getChildren(root))[0].description, 'Release');
    picks.push(items => {
        assert.equal(items.find(item => item.dimension).description, 'Release');
        return undefined;
    });
    await provider.configure();
    assert.deepEqual(c.contexts.getSelection({}), {}, 'Server defaults must not become explicit preferences');
    provider.dispose();
});

test('configuration is available in Contexts without adding a Target menu entry', () => {
    const manifest = require('../package.json');
    const menus = manifest.contributes.menus['view/item/context'];
    assert.ok(menus.some(item => item.command === 'bsp.configureContext' && item.when.includes('bspTargets')));
    assert.ok(menus.every(item => item.command !== 'bsp.configureContext' || item.when.includes('/buildContextScope/')));
    assert.ok(manifest.contributes.views.explorer.every(view => view.id !== 'bspContexts'));
    assert.ok(manifest.contributes.commands.some(item => item.command === 'bsp.configureContext'));
});

test('target execution projects only shared workspace fields and preserves the requested target', async () => {
    const calls = [], contexts = new BuildContexts(async (method, params) => {
        calls.push({ method, params });
        if (method === 'workspace/resolveContext') { return resolved(params); }
        if (!params.scope.targets) {
            assert.deepEqual(params.selection, {}, 'Schema discovery must ignore stale workspace-only preferences');
            return { selection: {}, operations: ['run'], dimensions: [
                { ...dimension(), required: false }, { ...dimension(), id: 'vendor.workspaceTarget', label: 'Target' }
            ] };
        }
        assert.equal(params.selection['vendor.workspaceTarget'], undefined);
        return { selection: params.selection, operations: ['test'], dimensions: [{ ...dimension(), required: false }] };
    });
    contexts.negotiate(accepted());
    await contexts.setSelection({}, { 'provider.mode': 'release', 'vendor.workspaceTarget': 'removed-target' });
    await contexts.setSelection(scope, { 'provider.mode': 'debug' });
    const result = await contexts.resolve(scope, 'test');
    assert.deepEqual(result.targets, [id]);
    assert.deepEqual(result.selection, { 'provider.mode': 'release' });
    assert.deepEqual(calls.at(-1).params.scope, scope);
    assert.deepEqual(contexts.getSelection(scope), { 'provider.mode': 'debug' }, 'Projection must not rewrite saved preferences');
    await contexts.reset({});
    const automatic = await contexts.resolve(scope, 'test');
    assert.deepEqual(automatic.selection, {}, 'Automatic must not revive the old target override');
});

test('workspace preferences apply to all target operations and stay isolated by connection', async () => {
    const a = new BuildContexts(transport().request), b = new BuildContexts(transport().request);
    a.negotiate(accepted()); b.negotiate(accepted());
    await a.setSelection({}, { 'provider.mode': 'release' });
    assert.equal((await a.resolve(scope, 'run')).selection['provider.mode'], 'release');
    assert.equal((await a.resolve(scope, 'debug')).selection['provider.mode'], 'release');
    assert.deepEqual((await b.resolve(scope, 'run')).selection, {});
});

test('incompatible shared choices reject target execution instead of using its default', async () => {
    const calls = [], contexts = new BuildContexts(async (method, params) => {
        calls.push(method);
        if (method === 'workspace/resolveContext') { return resolved(params); }
        const incompatible = params.scope.targets && params.selection['provider.mode'] === 'release';
        return { selection: params.selection, operations: ['run'], dimensions: [{ ...dimension(), required: false,
            options: [dimension().options[0], { id: 'release', label: 'Release', availability: !incompatible,
                reason: incompatible ? 'Release cannot run on this target' : undefined }] }] };
    });
    contexts.negotiate(accepted());
    await contexts.setSelection({}, { 'provider.mode': 'release' });
    await assert.rejects(contexts.resolve(scope, 'run'), /Release cannot run/);
    assert.ok(calls.every(method => method === 'workspace/contextOptions'));
});

test('target-only required choices prompt in the target scope while shared choices stay in Contexts', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => ({ selection: params.selection, dimensions: [
        { ...dimension(), required: false }, ...(params.scope.targets ? [{ ...dimension(), id: 'vendor.targetRuntime',
            label: 'Runtime', value: params.selection['vendor.targetRuntime'] }] : [])
    ] });
    await c.contexts.setSelection({}, { 'provider.mode': 'release' });
    picks.push(items => items.find(item => item.option?.id === 'debug'));
    await c.prepareDebugConfiguration(target);
    const resolvedRequest = c.requests.find(request => request.method === 'workspace/resolveContext');
    assert.deepEqual(resolvedRequest.params.selection, { 'provider.mode': 'release', 'vendor.targetRuntime': 'debug' });
    assert.deepEqual(c.contexts.getSelection({}), { 'provider.mode': 'release' });
    assert.deepEqual(c.contexts.getSelection(scope), { 'vendor.targetRuntime': 'debug' });
    assert.equal((await provider.getChildren()).length, 1);
    provider.dispose();
});

test('destination identifiers appear in the detail line without guessing opaque option IDs', async () => {
    const simulator = destination('simulator', { identifier: { label: 'UDID', value: 'SIMULATOR-UUID' }, osVersion: '18.2' });
    const device = destination('device', { identifier: { label: 'Serial', value: 'DEVICE-123' } });
    assert.match(contextOptionPresentation(simulator).detail, /^UDID: SIMULATOR-UUID/);
    assert.match(contextOptionPresentation(device).detail, /^Serial: DEVICE-123/);
    assert.doesNotMatch(contextOptionPresentation(destination('generic')).detail, /UDID/);
    const c = client(), provider = new BuildContextProvider(manager([c]));
    c.contextOptions = params => ({ selection: params.selection, dimensions: [{ ...dimension(), id: 'vendor.destination',
        label: 'Destination', required: false, value: params.selection['vendor.destination'],
        options: [destination('generic'), simulator, { ...device, availability: false, reason: 'Offline' }, destination('host')] }] });
    const root = (await provider.getChildren())[0];
    picks.push(items => {
        assert.deepEqual(items.filter(item => item.kind === vscode.QuickPickItemKind.Separator).map(item => item.label),
            ['Devices', 'Simulators', 'Generic destinations']);
        const row = items.find(item => item.option?.id === 'simulator');
        assert.equal(row.label, 'simulator');
        assert.match(row.description, /Example OS.*18.2/);
        assert.match(row.detail, /^UDID: SIMULATOR-UUID/);
        assert.match(row.detail, /Server description/);
        return undefined;
    });
    await provider.selectDimension((await provider.getChildren(root))[0]);
    provider.dispose();
});

function dependencyOptions(selection) {
    const choice = (id, values, extra = {}) => ({ id, label: id, kind: 'enum', required: id === 'group',
        options: values.map(value => ({ id: value, label: value })), ...extra });
    const group = selection.group ?? 'A';
    const dimensions = [choice('group', ['A', 'B', 'C', 'D']),
        choice('mode', group === 'C' ? ['debug'] : ['debug', 'release'], { enabled: group !== 'D' }),
        ...(group === 'D' ? [] : [choice('device', group === 'C' ? ['three'] : ['one', 'two'])])];
    for (const [id, value] of Object.entries(selection)) {
        const dimension = dimensions.find(item => item.id === id);
        assert.ok(dimension && dimension.enabled !== false && dimension.options.some(option => option.id === value),
            `The client sent an invalid dependent choice: ${id}=${value}`);
    }
    return { dimensions, selection };
}

test('upstream changes preserve compatible choices in dependency order without saving defaults', async () => {
    const requests = [], contexts = new BuildContexts(async (_method, params) => {
        requests.push(structuredClone(params.selection)); return dependencyOptions(params.selection);
    });
    contexts.negotiate(accepted());
    const original = { group: 'A', mode: 'release', device: 'one' };
    await contexts.setSelection(scope, original);
    const dimensions = dependencyOptions(original).dimensions;
    await contexts.choose(scope, 'group', 'B', dimensions);
    assert.deepEqual(requests, [{ group: 'B' }, { group: 'B', mode: 'release' }, { group: 'B', mode: 'release', device: 'one' }]);
    assert.deepEqual(contexts.getSelection(scope), { group: 'B', mode: 'release', device: 'one' });
    requests.length = 0;
    await contexts.choose(scope, 'group', 'B', dimensions);
    assert.equal(requests.length, 1, 'Choosing the same value must validate once without resetting dependencies');
    assert.deepEqual(contexts.getSelection(scope), { group: 'B', mode: 'release', device: 'one' });
    requests.length = 0;
    await contexts.choose(scope, 'device', 'two', dimensions);
    assert.equal(requests.length, 1, 'Changing the last dimension needs one validation request');
    assert.deepEqual(contexts.getSelection(scope), { group: 'B', mode: 'release', device: 'two' });
});

test('unavailable, disabled, and removed dependent choices are cleared without sending invalid selections', async () => {
    const contexts = new BuildContexts(async (_method, params) => dependencyOptions(params.selection));
    contexts.negotiate(accepted());
    const original = { group: 'A', mode: 'release', device: 'one' };
    const dimensions = dependencyOptions(original).dimensions;
    await contexts.setSelection(scope, original);
    await contexts.choose(scope, 'group', 'C', dimensions);
    assert.deepEqual(contexts.getSelection(scope), { group: 'C' });
    await contexts.setSelection(scope, original);
    await contexts.choose(scope, 'group', 'D', dimensions);
    assert.deepEqual(contexts.getSelection(scope), { group: 'D' });
});

test('Automatic retains compatible downstream values and does not materialize a server default', async () => {
    const requests = [], contexts = new BuildContexts(async (_method, params) => {
        requests.push(structuredClone(params.selection));
        const options = dependencyOptions(params.selection);
        options.dimensions.find(item => item.id === 'mode').value = params.selection.mode ?? 'debug';
        return options;
    });
    contexts.negotiate(accepted());
    const original = { group: 'A', mode: 'release', device: 'one' };
    await contexts.setSelection(scope, original);
    await contexts.choose(scope, 'mode', undefined, dependencyOptions(original).dimensions);
    assert.deepEqual(requests, [{ group: 'A' }, { group: 'A', device: 'one' }]);
    assert.deepEqual(contexts.getSelection(scope), { group: 'A', device: 'one' });
});

test('failed or cancelled compatibility validation leaves shared preferences unchanged', async () => {
    for (const cancelled of [false, true]) {
        const source = new CancellationTokenSource();
        const contexts = new BuildContexts(async (_method, params) => {
            if (params.selection.group === 'B' && params.selection.mode === 'release') {
                if (cancelled) { source.cancel(); } else { throw new Error('Discovery failed'); }
            }
            return dependencyOptions(params.selection);
        });
        contexts.negotiate(accepted());
        const original = { group: 'A', mode: 'release', device: 'one' };
        await contexts.setSelection(scope, original);
        await assert.rejects(contexts.choose(scope, 'group', 'B', dependencyOptions(original).dimensions, source.token),
            cancelled ? /cancelled/ : /Discovery failed/);
        assert.deepEqual(contexts.getSelection(scope), original);
    }
});

test('shared choices remain editable when the server reduces supported operations', async () => {
    const server = transport(), contexts = new BuildContexts(server.request);
    contexts.negotiate(accepted());
    await contexts.setSelection(scope, { 'provider.mode': 'release' });
    contexts.negotiate(accepted(['compile']));
    await contexts.choose(scope, 'provider.mode', 'debug', [dimension()]);
    assert.deepEqual(contexts.getSelection(scope), { 'provider.mode': 'debug' });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, 'workspace/contextOptions');
});

test('reuse requires a valid advertised capability and is reset on negotiation or disconnect', () => {
    const contexts = new BuildContexts(transport().request);
    contexts.negotiate(accepted()); assert.equal(contexts.supportsReuse, false);
    contexts.negotiate(accepted(undefined, ['build'])); assert.equal(contexts.supportsReuse, false);
    contexts.negotiate(accepted(undefined, ['build', 'reuse'])); assert.equal(contexts.supportsReuse, true);
    contexts.negotiate(accepted()); assert.equal(contexts.supportsReuse, false);
    for (const malformed of ['reuse', null, [], ['reuse'], [true], ['future']]) {
        contexts.negotiate(accepted(undefined, ['build', 'reuse']));
        assert.throws(() => contexts.negotiate(accepted(undefined, malformed)), /invalid build context capability/);
        assert.equal(contexts.supportsReuse, false);
        assert.equal(contexts.enabled, false);
    }
    contexts.negotiate(accepted(undefined, ['build', 'reuse']));
    contexts.disconnect(); assert.equal(contexts.supportsReuse, false);
});

test('reuse run, test, and debug freeze policy at resolution and execute with only the context ID', async () => {
    for (const operation of ['run', 'test', 'debug']) {
        const c = client(), events = [], source = new CancellationTokenSource();
        c.contexts.negotiate(accepted(undefined, ['build', 'reuse']));
        c.onTestEvent(event => events.push(event));
        const testTarget = { ...target, capabilities: { ...target.capabilities, canRun: false } };
        const noticesBefore = notices.length;
        if (operation === 'run') { await c.runWithoutBuilding(target); }
        else if (operation === 'test') {
            await c.testWithoutBuilding(target, { native: true, token: source.token,
                selection: { dataKind: 'test-cases', data: { ids: ['case-1'] } } });
        } else { await c.debugWithoutBuilding(testTarget); }
        const resolve = c.requests.find(request => request.method === 'workspace/resolveContext');
        assert.equal(resolve.params.buildPolicy, 'reuse');
        assert.equal(resolve.params.operation, operation);
        const execute = c.requests.at(-1);
        assert.equal(execute.method, operation === 'debug' ? 'debugSession/start' : `buildTarget/${operation}`);
        assert.deepEqual(execute.params.executionContext, { id: 'context-' + operation });
        assert.equal(Object.hasOwn(execute.params, 'buildPolicy'), false);
        assert.equal(Object.hasOwn(execute.params, 'arguments'), false);
        assert.ok(!c.requests.some(request => request.method === 'buildTarget/compile'));
        for (const request of c.requests.filter(request => request.method === 'workspace/contextOptions')) {
            assert.equal(Object.hasOwn(request.params, 'operation'), false);
            assert.equal(Object.hasOwn(request.params, 'buildPolicy'), false);
            assert.deepEqual(Object.keys(request.params).sort(), ['scope', 'selection']);
        }
        if (operation === 'test') {
            assert.deepEqual(execute.params.data, { ids: ['case-1'] });
            assert.equal(execute.params.dataKind, 'test-cases');
            assert.deepEqual(events.map(event => event.kind), ['started', 'finished']);
            assert.equal(notices.length, noticesBefore, 'Native tests must not show a second result');
        } else if (operation === 'debug') { assert.equal(starts.at(-1).stopOnEntry, false); }
        assert.deepEqual(c.contexts.getSelection(scope), {}, 'Policies are not saved as preferences');
        source.dispose();
    }
});

test('reuse rejects a missing or different server policy without executing or falling back', async () => {
    for (const policy of [undefined, 'build', null, 'future']) {
        const c = client();
        c.contexts.negotiate(accepted(undefined, ['build', 'reuse']));
        const send = c.connection.sendRequest;
        c.connection.sendRequest = async (method, params, token) => {
            const result = await send(method, params, token);
            if (method === 'workspace/resolveContext') {
                delete result.buildPolicy;
                if (policy !== undefined) { result.buildPolicy = policy; }
            }
            return result;
        };
        await assert.rejects(c.runWithoutBuilding(target), /does not match the requested build policy/);
        assert.ok(c.requests.every(request => request.method.startsWith('workspace/')));
        assert.equal(c.operations.get(id.uri), undefined);
    }
});

test('normal execution omits the policy and accepts old responses as build', async () => {
    const c = client();
    c.contexts.negotiate(accepted(undefined, ['build', 'reuse']));
    await c.run(target);
    const resolution = c.requests.find(request => request.method === 'workspace/resolveContext');
    assert.equal(Object.hasOwn(resolution.params, 'buildPolicy'), false);
    assert.equal(c.requests.at(-1).method, 'buildTarget/run');
    c.requests.length = 0;
    const send = c.connection.sendRequest;
    c.connection.sendRequest = async (method, params, token) => {
        const result = await send(method, params, token);
        return method === 'workspace/resolveContext' ? { ...result, buildPolicy: 'reuse' } : result;
    };
    await assert.rejects(c.run(target), /does not match the requested build policy/);
    assert.ok(c.requests.every(request => request.method.startsWith('workspace/')));
});

test('Contexts scope reuse actions follow negotiation and preserve standard capabilities', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    const root = (await provider.getChildren())[0];
    assert.doesNotMatch(root.contextValue, /canReuseBuild/);
    c.requests.length = 0;
    await assert.rejects(provider.execute(root, 'run', 'reuse'), /does not support execution without building/);
    assert.equal(c.requests.length, 0);
    c.contexts.negotiate(accepted(undefined, ['build', 'reuse']));
    assert.match((await provider.getChildren())[0].contextValue, /canReuseBuild/);
    await provider.execute(root, 'run', 'reuse');
    assert.equal(c.requests.findLast(request => request.method === 'workspace/resolveContext').params.buildPolicy, 'reuse');
    assert.deepEqual(c.requests.at(-1).params.executionContext, { id: 'context-run' });
    c.contextOptions = params => ({ ...options(params.selection), operations: ['compile'] });
    const limited = (await provider.getChildren())[0];
    assert.doesNotMatch(limited.contextValue, /canRun|canTest|canDebug/);
    await assert.rejects(provider.execute(limited, 'run', 'reuse'), /does not support run/);
    provider.dispose();
});

test('BSP explorer groups all targets by the dependency tag and preserves server order', async t => {
    const c = client(false), m = manager([c]);
    const contexts = new BuildContextProvider(m), explorer = new MultiBspProvider(m, undefined, contexts);
    t.after(() => { explorer.dispose(); contexts.dispose(); });
    const library = { ...target, id: { uri: 'target://library' }, displayName: 'Library', tags: ['dependency', 'library'] };
    const dependencyTests = { ...target, id: { uri: 'target://library-tests' }, displayName: 'LibraryTests',
        tags: ['dependency', 'test'], capabilities: { canTest: true, canDebug: true } };
    const app = { ...target, dependencies: [library.id] };
    const appTests = { ...target, id: { uri: 'target://app-tests' }, displayName: 'AppTests', tags: ['test'] };
    c.buildTargets = [library, app, dependencyTests, appTests];
    const [server] = await explorer.getChildren();
    const groups = await explorer.getChildren(server);
    assert.deepEqual(groups.map(item => item.label), ['Targets (2)', 'Dependencies (2)']);
    assert.deepEqual(groups.map(item => item.collapsibleState), [2, 1]);
    assert.ok(groups.every(item => item.contextValue === 'targetCollection'));
    const roots = await explorer.getChildren(groups[0]), dependencies = await explorer.getChildren(groups[1]);
    assert.deepEqual(roots.map(item => item.buildTarget), [app, appTests]);
    assert.deepEqual(dependencies.map(item => item.buildTarget), [library, dependencyTests]);
    assert.match(explorer.getTreeItem(dependencies[0]).contextValue, /canCompile/);
    assert.match(explorer.getTreeItem(dependencies[1]).contextValue, /canTest.*canDebug/);
    assert.doesNotMatch(explorer.getTreeItem(dependencies[1]).contextValue, /canCompile|canRun/);
    const details = await explorer.getChildren(roots[0]);
    const references = await explorer.getChildren(details.find(item => item.type === 'dependencies'));
    assert.deepEqual(references.map(item => item.buildTarget), [library]);
    assert.equal(references[0].collapsibleState, 0);
    assert.equal(c.requests.length, 0, 'Standard servers must not receive configuration queries');
    const refreshed = await explorer.getChildren(server);
    assert.deepEqual(refreshed.map(item => item.id), groups.map(item => item.id));
});

test('BSP explorer loads context fields independently and refreshes only the changed scope', async t => {
    const c = client(), other = client(), m = manager([c, other]);
    const contexts = new BuildContextProvider(m), explorer = new MultiBspProvider(m, undefined, contexts);
    t.after(() => { explorer.dispose(); contexts.dispose(); });
    const [server, otherServer] = await explorer.getChildren();
    const [root, targets, dependencies] = await explorer.getChildren(server);
    const [otherRoot, otherTargets] = await explorer.getChildren(otherServer);
    assert.equal(root.label, 'Build Context');
    assert.equal(targets.label, 'Targets (1)');
    assert.equal(dependencies.label, 'Dependencies (0)');
    assert.equal(dependencies.collapsibleState, 0);
    assert.notEqual(root.id, otherRoot.id);
    assert.notEqual(targets.id, otherTargets.id);
    assert.notEqual((await explorer.getChildren(targets))[0].id, (await explorer.getChildren(otherTargets))[0].id);
    assert.equal(c.requests.length, 0);
    assert.equal(other.requests.length, 0);
    const changes = [];
    explorer.onDidChangeTreeData(item => changes.push(item));
    let resolveOptions;
    c.contextOptions = params => new Promise(resolve => { resolveOptions = () => resolve(options(params.selection)); });
    const pending = explorer.getChildren(root);
    assert.equal((await explorer.getChildren(targets)).length, 1, 'Targets must remain accessible while configuration loads');
    assert.equal((await explorer.getChildren(otherServer))[0], otherRoot);
    resolveOptions();
    const fields = await pending;
    assert.deepEqual(fields.map(item => item.label), ['Build mode']);
    assert.match(explorer.getTreeItem(root).contextValue, /canCompile.*canRun.*canTest.*canDebug/);
    assert.deepEqual(changes, [root]);
    await explorer.getChildren(root);
    assert.equal(c.requests.length, 1, 'Expanding the same scope must reuse its configuration');
    assert.deepEqual(changes, [root], 'Cached scopes must not cause refresh loops');
    c.contextOptions = params => options(params.selection);
    changes.length = 0;
    picks.push(items => items.find(item => item.option?.id === 'release'));
    await contexts.selectDimension(fields[0]);
    assert.deepEqual(changes, [root]);
    assert.equal((await explorer.getChildren(root))[0].description, 'Release');
    assert.deepEqual(other.contexts.getSelection({}), {});
    assert.equal(other.requests.length, 0);
    await contexts.execute(root, 'run');
    assert.equal(c.requests.at(-1).method, 'buildTarget/run');
    const resolved = c.requests.find(request => request.method === 'workspace/resolveContext');
    assert.equal(resolved.params.selection['provider.mode'], 'release');
});

test('BSP explorer refreshes groups after target updates and reconnects', async t => {
    const c = client(), m = manager([c]);
    const contexts = new BuildContextProvider(m), explorer = new MultiBspProvider(m, undefined, contexts);
    t.after(() => { explorer.dispose(); contexts.dispose(); });
    const [server] = await explorer.getChildren();
    const [root, targets, dependencies] = await explorer.getChildren(server);
    await explorer.getChildren(root);
    const library = { ...target, id: { uri: 'target://library' }, tags: ['dependency'] };
    c.buildTargets.push(library);
    m.updates.fire();
    const updated = await explorer.getChildren(server);
    assert.deepEqual(updated.map(item => item.label), ['Build Context', 'Targets (1)', 'Dependencies (1)']);
    assert.equal(updated[0], root);
    assert.deepEqual(updated.slice(1).map(item => item.id), [targets.id, dependencies.id]);
    assert.equal(root.snapshot, undefined);
    assert.doesNotMatch(root.contextValue, /canCompile/);
    await explorer.getChildren(root);
    assert.match(root.contextValue, /canCompile/);
    m.connections[0].connected = false;
    c.isConnected = false;
    m.changes.fire();
    assert.equal(contexts.getConnectionItem(m.connections[0].id), undefined);
    assert.deepEqual((await explorer.getChildren(server)).map(item => item.label), ['Disconnected']);
    assert.deepEqual(await explorer.getChildren(targets), []);
    const replacement = client(false);
    Object.assign(m.connections[0], { connected: true, client: replacement });
    m.changes.fire();
    assert.deepEqual((await explorer.getChildren(server)).map(item => item.label), ['Targets (1)', 'Dependencies (0)']);
    replacement.contexts.negotiate(accepted());
    m.changes.fire();
    const [newRoot] = await explorer.getChildren(server);
    assert.notEqual(newRoot, root);
    assert.equal(newRoot.id, root.id);
    assert.equal(newRoot.entry.client, replacement);
    explorer.dispose(); contexts.dispose();
    assert.equal(m.changes.listeners.size, 0);
    assert.equal(m.updates.listeners.size, 0);
});

test('BSP explorer handles failed and empty target discovery without filtering dependency-only projects', async t => {
    const c = client(false), m = manager([c]);
    const explorer = new MultiBspProvider(m);
    t.after(() => explorer.dispose());
    const [server] = await explorer.getChildren();
    let requests = 0;
    c.buildTargets = [];
    c.getBuildTargets = async () => { requests++; throw new Error('Discovery failed'); };
    const [error] = await explorer.getChildren(server);
    assert.equal(error.type, 'error');
    assert.match(error.label, /Discovery failed/);
    c.getBuildTargets = async () => { requests++; return []; };
    const empty = await explorer.getChildren(server);
    assert.deepEqual(empty.map(item => item.label), ['Targets (0)', 'Dependencies (0)']);
    assert.ok(empty.every(item => item.collapsibleState === 0));
    assert.deepEqual(await explorer.getChildren(empty[0]), []);
    assert.deepEqual(await explorer.getChildren(empty[1]), []);
    assert.equal(requests, 2, 'Expanding groups must not repeat target discovery');
    c.getBuildTargets = async () => {
        requests++;
        c.buildTargets = [{ ...target, tags: ['dependency', 'test'] }];
        return c.buildTargets;
    };
    const groups = await explorer.getChildren(server);
    assert.deepEqual(groups.map(item => item.label), ['Targets (0)', 'Dependencies (1)']);
    assert.equal((await explorer.getChildren(groups[1])).length, 1);
    assert.equal(requests, 3);
});

test('favorites belong to one BSP configuration and survive connection ID changes', async t => {
    const first = client(false), second = client(false), third = client(false);
    const m = manager([first, second, third]);
    m.connections.forEach((connection, index) => {
        connection.config = { name: 'BSP', displayName: 'BSP',
            configPath: index === 2 ? '/workspace/.bsp/other.json' : '/workspace/.bsp/server.json',
            workspaceUri: { toString: () => index === 1 ? 'file:///other-workspace' : 'file:///workspace' } };
    });
    const saved = new Map();
    const context = { workspaceState: { get: (key, fallback) => saved.get(key) ?? fallback,
        update: async (key, value) => { saved.set(key, structuredClone(value)); } } };
    let explorer = new MultiBspProvider(m, context);
    t.after(() => explorer.dispose());
    await explorer.addToFavorites(id.uri, m.connections[0].id);
    let servers = await explorer.getChildren();
    assert.ok(servers.every(item => item.type === 'connection'));
    assert.equal(servers[0].description, undefined);
    assert.match(servers[0].tooltip, /Status: Connected/);
    assert.deepEqual((await explorer.getChildren(servers[0])).map(item => item.label),
        ['Favorites (1)', 'Targets (1)', 'Dependencies (0)']);
    for (const server of servers.slice(1)) {
        assert.ok((await explorer.getChildren(server)).every(item => item.type !== 'favoritesGroup'));
    }
    const [favorites, targets] = await explorer.getChildren(servers[0]);
    const [favorite] = await explorer.getChildren(favorites);
    const [normal] = await explorer.getChildren(targets);
    assert.equal(favorite.label, 'App');
    assert.notEqual(favorite.id, normal.id);
    assert.match(explorer.getTreeItem(normal).contextValue, /favorite/);
    const [otherTargets] = await explorer.getChildren(servers[1]);
    const [otherNormal] = await explorer.getChildren(otherTargets);
    assert.doesNotMatch(explorer.getTreeItem(otherNormal).contextValue, /favorite/);
    await explorer.addToFavorites(id.uri, m.connections[1].id);
    await explorer.addToFavorites(id.uri, m.connections[2].id);
    await explorer.removeFromFavorites(id.uri, m.connections[0].id);
    assert.equal(explorer.isFavorite(id.uri, m.connections[0].id), false);
    assert.equal(explorer.isFavorite(id.uri, m.connections[1].id), true);
    assert.equal(explorer.isFavorite(id.uri, m.connections[2].id), true);
    await explorer.addToFavorites(id.uri, m.connections[0].id);
    explorer.dispose();
    m.connections.forEach((connection, index) => { connection.id = 'reconnected-' + index; connection.connectionId = connection.id; });
    explorer = new MultiBspProvider(m, context);
    servers = await explorer.getChildren();
    const [restoredGroup] = await explorer.getChildren(servers[0]);
    const [restored] = await explorer.getChildren(restoredGroup);
    assert.equal(restoredGroup.id, favorites.id);
    assert.equal(restored.id, favorite.id);
    assert.equal(restored.connectionId, 'reconnected-0');
    m.connections[0].connected = false;
    m.changes.fire();
    const [offlineServer] = await explorer.getChildren();
    assert.match(offlineServer.description, /Disconnected/);
    const [offlineGroup, status] = await explorer.getChildren(offlineServer);
    assert.equal(status.label, 'Disconnected');
    const [offlineFavorite] = await explorer.getChildren(offlineGroup);
    assert.match(offlineFavorite.contextValue, /favorite disconnected/);
    assert.equal(offlineFavorite.connectionId, 'reconnected-0');
    assert.equal(offlineFavorite.buildTarget.capabilities.canRun, false);
    await explorer.removeFromFavorites(id.uri, 'reconnected-0');
    assert.deepEqual((await explorer.getChildren(offlineServer)).map(item => item.label), ['Disconnected']);
});

test('legacy favorites migrate only when their connection is unambiguous', async t => {
    const a = client(false), b = client(false), m = manager([a, b]);
    const unique = { ...target, id: { uri: 'target://unique' } };
    a.buildTargets.push(unique);
    m.connections[1].connected = false;
    b.buildTargets = [];
    const saved = new Map([['bsp.favoriteTargets', [unique.id.uri, id.uri]]]);
    const context = { workspaceState: { get: (key, fallback) => saved.get(key) ?? fallback,
        update: async (key, value) => { saved.set(key, structuredClone(value)); } } };
    const explorer = new MultiBspProvider(m, context);
    t.after(() => explorer.dispose());
    assert.equal(explorer.isFavorite(unique.id.uri, 'connection-0'), false);
    b.buildTargets = [target]; m.connections[1].connected = true;
    m.changes.fire();
    assert.equal(explorer.isFavorite(unique.id.uri, 'connection-0'), true);
    assert.equal(explorer.isFavorite(id.uri, 'connection-0'), false);
    assert.equal(explorer.isFavorite(id.uri, 'connection-1'), false);
    assert.deepEqual(saved.get('bsp.favoriteTargetsByConnection').unassigned, [id.uri]);
    await explorer.addToFavorites(id.uri, 'connection-1');
    assert.equal(explorer.isFavorite(id.uri, 'connection-1'), true);
    assert.deepEqual(saved.get('bsp.favoriteTargetsByConnection').unassigned, []);
});

function recentSection(items) {
    const start = items.findIndex(item => item.kind === vscode.QuickPickItemKind.Separator && item.label === 'Recent');
    if (start < 0) { return []; }
    const end = items.findIndex((item, index) => index > start && item.kind === vscode.QuickPickItemKind.Separator);
    return items.slice(start + 1, end < 0 ? undefined : end);
}

function recentPickerFixture(t, count = 6) {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    const values = Array.from({ length: count }, (_, i) => ({ id: 'option-' + i, label: 'Option ' + i }));
    let available = values;
    c.contextOptions = params => ({ selection: params.selection, dimensions: [{
        id: 'provider.mode', label: 'Mode', kind: 'enum', required: false, options: available
    }] });
    const item = new ContextTreeItem({ connectionId: 'connection-0', client: c, label: 'BSP', scope: {} },
        { id: 'provider.mode', label: 'Mode', kind: 'enum', required: false, options: values });
    t.after(() => provider.dispose());
    return { c, provider, item, values, setOptions: value => { available = value; },
        choose: async id => {
            picks.push(items => items.find(item => item.option?.id === id));
            assert.equal(await provider.selectDimension(item), true);
        },
        inspect: async action => {
            let failure;
            picks.push((items, picker) => {
                try { action(items, picker); } catch (error) { failure = error; }
                return undefined;
            });
            assert.equal(await provider.selectDimension(item), false);
            if (failure) { throw failure; }
        } };
}

test('Recent appears at five server options and keeps smaller pickers unchanged', async t => {
    const f = recentPickerFixture(t, 5);
    await f.inspect(items => assert.equal(recentSection(items).length, 0));
    await f.choose('option-0');
    f.setOptions(f.values.slice(0, 4));
    await f.inspect(items => {
        assert.deepEqual(items.map(item => item.label), ['Automatic', 'Option 0', 'Option 1', 'Option 2', 'Option 3']);
    });
    f.setOptions(f.values);
    await f.inspect((items, picker) => {
        assert.deepEqual(recentSection(items).map(item => item.option.id), ['option-0']);
        assert.deepEqual(items.filter(item => item.kind === -1).map(item => item.label), ['Recent', 'All options']);
        assert.equal(picker.activeItems[0], recentSection(items)[0]);
        assert.deepEqual(items.slice(items.findIndex(item => item.label === 'All options') + 1).map(item => item.option.id),
            f.values.map(option => option.id));
    });
});

test('Recent keeps five successful choices in usage order without duplicates', async t => {
    const f = recentPickerFixture(t);
    for (const value of f.values) { await f.choose(value.id); }
    await f.choose('option-2');
    const expected = ['option-2', 'option-5', 'option-4', 'option-3', 'option-1'];
    await f.inspect(items => assert.deepEqual(recentSection(items).map(item => item.option.id), expected));
    assert.deepEqual(f.c.contexts.recentOptions({}, 'provider.mode'), expected);
    picks.push(items => items.find(item => item.label === 'Automatic'));
    assert.equal(await f.provider.selectDimension(f.item), true);
    assert.deepEqual(f.c.contexts.recentOptions({}, 'provider.mode'), expected);
    const source = new CancellationTokenSource();
    source.cancel();
    assert.equal(await f.provider.selectDimension(f.item, source.token), false);
    const normal = f.c.contextOptions;
    f.c.contextOptions = params => {
        if (params.selection['provider.mode'] === 'option-0') { throw new Error('Selection rejected'); }
        return normal(params);
    };
    picks.push(items => items.find(item => item.option?.id === 'option-0'));
    await assert.rejects(f.provider.selectDimension(f.item), /Selection rejected/);
    assert.deepEqual(f.c.contexts.recentOptions({}, 'provider.mode'), expected);
});

test('Recent uses current destination labels, excludes stale choices, and preserves destination groups', async t => {
    const f = recentPickerFixture(t);
    await f.choose('option-0'); await f.choose('option-1'); await f.choose('option-2');
    const current = [
        { ...f.values[0], label: 'Renamed device', ...{ dataKind: 'execution-destination', data: {
            kind: 'device', platform: { id: 'ios', label: 'iOS' }, architecture: 'arm64' } } },
        { ...f.values[1], availability: false, reason: 'Offline' },
        ...f.values.slice(3),
        { id: 'extra', label: 'Extra', dataKind: 'execution-destination', data: { kind: 'simulator',
            platform: { id: 'ios', label: 'iOS' } } }
    ];
    f.setOptions(current);
    await f.inspect(items => {
        assert.deepEqual(recentSection(items).map(item => item.label), ['Renamed device']);
        assert.match(recentSection(items)[0].description, /iOS.*arm64/);
        assert.deepEqual(items.filter(item => item.kind === -1).map(item => item.label),
            ['Recent', 'Devices', 'Simulators', 'Other destinations']);
        assert.ok(items.find(item => item.option?.id === 'option-1'), 'Unavailable choices remain in the full list');
    });
    picks.push(items => items.find(item => item.option?.id === 'option-1'));
    assert.equal(await f.provider.selectDimension(f.item), false);
    assert.deepEqual(f.c.contexts.recentOptions({}, 'provider.mode'), ['option-2', 'option-1', 'option-0']);
});

test('Recent history persists by connection, workspace, target scope, and field', async () => {
    const saved = new Map(), storage = { get: key => saved.get(key),
        update: async (key, value) => { saved.set(key, structuredClone(value)); } };
    const create = (identity, workspace = 'file:///workspace') => {
        const contexts = new BuildContexts(transport().request);
        contexts.attachPreferences(storage, identity, workspace);
        return contexts;
    };
    const a = create('server-A');
    await a.rememberOption({}, 'mode', 'release');
    await a.rememberOption(scope, 'mode', 'debug');
    const restored = create('server-A');
    assert.deepEqual(restored.recentOptions({}, 'mode'), ['release']);
    assert.deepEqual(restored.recentOptions({ workspaceUri: 'file:///workspace' }, 'mode'), ['release']);
    assert.deepEqual(restored.recentOptions(scope, 'mode'), ['debug']);
    assert.deepEqual(restored.recentOptions({}, 'destination'), []);
    assert.deepEqual(restored.recentOptions({ targets: [{ uri: 'target://other' }] }, 'mode'), []);
    assert.deepEqual(create('server-B').recentOptions({}, 'mode'), []);
    assert.deepEqual(create('server-A', 'file:///other-workspace').recentOptions({}, 'mode'), []);
    assert.deepEqual(restored.getSelection({}), {}, 'History must not select configuration values');
});

test('Build Context hides execution while busy, rejects duplicate clicks, and restores cached capabilities', async () => {
    const c = client(), other = client(), connections = manager([c, other]);
    const provider = new BuildContextProvider(connections), tree = new MultiBspProvider(connections, undefined, provider);
    const [root, idle] = await provider.getChildren();
    const capabilities = root.contextValue;
    let finish;
    const send = c.connection.sendRequest;
    c.connection.sendRequest = (method, params, token) => {
        if (method !== 'buildTarget/compile') { return send(method, params, token); }
        c.requests.push({ method, params, token });
        return new Promise(resolve => { finish = resolve; });
    };
    let updates = 0;
    provider.onDidChangeTreeData(() => updates++);
    const pending = provider.execute(root, 'compile');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finish, 'function');
    assert.ok(updates > 0);
    assert.match(tree.getTreeItem(root).contextValue, /busy/);
    assert.doesNotMatch(tree.getTreeItem(idle).contextValue, /busy/);
    const requests = c.requests.length;
    for (const operation of ['compile', 'run', 'test', 'debug']) {
        await assert.rejects(provider.execute(root, operation), /Wait for the current operation/);
    }
    assert.equal(c.requests.length, requests);
    c.operations.cancel('workspace');
    assert.match(tree.getTreeItem(root).contextValue, /busy/);
    await assert.rejects(provider.execute(root, 'run', 'reuse'), /Wait for the current operation/);
    finish({ statusCode: 3 }); await pending;
    assert.equal(tree.getTreeItem(root).contextValue, capabilities);
    assert.equal(c.requests.length, requests, 'Busy updates must not reload configuration');
    await provider.execute(root, 'run');
    const menus = require('../package.json').contributes.menus['view/item/context'];
    for (const menu of menus.filter(menu => /^bsp\.context(?:Compile|Run|Test|Debug)/.test(menu.command))) {
        assert.match(menu.when, /!\(viewItem =~ \/busy\/\)/);
    }
    tree.dispose(); provider.dispose();
});

test('Build Context rechecks active target operations after loading configuration', async () => {
    const c = client(), provider = new BuildContextProvider(manager([c]));
    const [root] = await provider.getChildren();
    let releaseOptions, releaseTarget;
    c.contextOptions = params => new Promise(resolve => { releaseOptions = () => resolve(options(params.selection)); });
    const pending = provider.execute(root, 'run');
    const active = c.operations.run(id.uri, 'compile', () => new Promise(resolve => { releaseTarget = resolve; }));
    releaseOptions();
    await assert.rejects(pending, /Wait for the current operation/);
    assert.ok(!c.requests.some(request => request.method === 'workspace/resolveContext'));
    await assert.rejects(c.executeContext('run'), /Wait for the current operation/);
    releaseTarget(); await active;
    provider.dispose();
});
