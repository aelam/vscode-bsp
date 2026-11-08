const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { CancellationToken } = require('vscode-jsonrpc/node');
class Emitter {
    listeners = new Set();
    event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    fire(value) { for (const fn of [...this.listeners]) fn(value); }
    dispose() { this.listeners.clear(); }
}
const folders = [];
const uri = fsPath => ({ fsPath, toString: () => `file://${fsPath}` });
const vscode = {
    EventEmitter: Emitter,
    workspace: { getWorkspaceFolder: value => folders.find(folder => folder.uri.toString() === value.toString()) },
    window: { showQuickPick: () => assert.fail('An explicit task or launch must not show a target picker'), showInformationMessage() {} },
    TaskGroup: { Build: { id: 'build' }, Test: { id: 'test' } },
    CustomExecution: class { constructor(callback) { this.callback = callback; } },
    Task: class { constructor(definition, scope, name, source, execution, problemMatchers) {
        Object.assign(this, { definition, scope, name, source, execution, problemMatchers });
    } }
};
const load = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let BspTaskProvider, BspTargetResolver, BspDebugConfigurationProvider;
try {
    ({ BspTaskProvider } = require('../out/bspTaskProvider'));
    ({ BspTargetResolver } = require('../out/bspTargetResolver'));
    ({ BspDebugConfigurationProvider } = require('../out/debugProvider'));
} finally { Module._load = load; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function target(name = 'App', extra = {}) {
    return { id: { uri: `target://${name}` }, displayName: name, languageIds: ['swift'],
        capabilities: { canCompile: true, canRun: true, canTest: true, canDebug: true }, ...extra };
}
function connection(root, file, targets = [target()], context = false) {
    const folder = { uri: uri(root), name: path.basename(root), index: folders.length }; folders.push(folder);
    const calls = [];
    const client = {
        connected: true, targets, calls,
        contexts: { enabled: context, supportsReuse: context, operations: ['compile', 'run', 'test', 'debug'] },
        getBuildTargets: async token => { assert.ok(!token?.isCancellationRequested); return client.targets; },
        supportsOperation: (operation, selected = client.targets[0]) => selected.capabilities[`can${operation[0].toUpperCase()}${operation.slice(1)}`] === true,
        compile: async (selected, token, options = {}) => { calls.push(['compile', selected, token]); options.onOutput?.('Compiling\nSources'); return { statusCode: 1 }; },
        run: async (selected, token) => { calls.push(['run', selected, token]); return { statusCode: 1 }; },
        test: async (selected, options) => { calls.push(['test', selected, options.token]); return { statusCode: 1 }; },
        executeContext: async (...args) => { calls.push(['context', ...args]); args[3].onOutput?.('Building'); return { statusCode: 1 }; },
        prepareDebugConfiguration: async (...args) => { calls.push(['debug', ...args]); return { type: 'bsp-debug', request: 'attach', name: 'App', connect: { port: 23456, host: 'localhost' } }; }
    };
    return { id: `${root}/${file}`, client, connected: true, folder,
        config: { name: 'Server', workspaceUri: folder.uri, configPath: path.join(root, '.bsp', file) } };
}
function setup(connections) {
    const manager = { getAllConnections: () => connections, async connectToServer(id) {
        const found = connections.find(c => c.id === id); found.client.connected = true; found.connected = true;
    } };
    const resolver = new BspTargetResolver(manager);
    return { resolver, provider: new BspTaskProvider(resolver), manager };
}
async function terminal(provider, conn, value = {}, metadata = {}, resolved = undefined) {
    const task = Object.assign(new vscode.Task({ type: 'bsp', operation: 'compile', target: 'App', ...value }, conn.folder,
        'Custom task', 'BSP', undefined, []), metadata);
    const definition = task.definition;
    assert.equal(provider.resolveTask(task, CancellationToken.None), task);
    assert.equal(task.definition, definition);
    const pty = await task.execution.callback(resolved ?? definition), output = [];
    let exited = false;
    pty.onDidWrite(message => output.push(message));
    const done = new Promise(resolve => pty.onDidClose(code => { assert.equal(exited, false); exited = true; resolve(code); }));
    return { task, pty, done, output };
}

test('discovers capability-filtered tasks with stable connection files and separate workspace scopes', async () => {
    const a = connection('/tasks-one', 'a.json', [target('App', { capabilities: { canCompile: true } })]);
    const b = connection('/tasks-two', 'b.json', [target('App')], true);
    b.client.contexts.operations = ['compile', 'test'];
    const { provider } = setup([a, b]);
    const tasks = await provider.provideTasks(CancellationToken.None);
    assert.deepEqual(tasks.map(t => t.definition.operation), ['compile', 'compile', 'test']);
    assert.deepEqual(tasks.map(t => t.definition.connection), ['.bsp/a.json', '.bsp/b.json', '.bsp/b.json']);
    assert.equal(tasks[0].scope, a.folder); assert.equal(tasks[1].scope, b.folder);
    assert.equal(tasks[0].group, vscode.TaskGroup.Build); assert.equal(tasks[2].group, vscode.TaskGroup.Test);
    assert.ok(tasks.every(t => t.execution instanceof vscode.CustomExecution));
    assert.equal(a.client.calls.length + b.client.calls.length, 0);
});

test('explicit targets resolve by URI or unique name and never choose an ambiguous connection', async () => {
    const a = connection('/tasks-shared', 'a.json'), b = connection('/tasks-shared', 'b.json');
    const { resolver } = setup([a, b]);
    await assert.rejects(resolver.resolve({ target: 'App' }, 'compile', a.folder), /ambiguous/);
    assert.equal((await resolver.resolve({ connection: '.bsp/b.json', target: 'App' }, 'compile', a.folder)).connection, b);
    assert.equal((await resolver.resolve({ connection: b.config.configPath, target: 'target://App' }, 'debug', a.folder)).target, b.client.targets[0]);
    await assert.rejects(resolver.resolve({ connection: '.bsp/missing.json', target: 'App' }, 'compile', a.folder), /not found/);
    await assert.rejects(resolver.resolve({ connection: '.bsp/a.json', target: 'Missing' }, 'compile', a.folder), /not found/);
    assert.equal(a.client.calls.length + b.client.calls.length, 0);
});

test('tasks wait for terminal open, use substituted definitions, and preserve configured task metadata', async () => {
    const c = connection('/tasks-resolved', 'a.json'), { provider } = setup([c]);
    const presentationOptions = { reveal: 2 }, runOptions = { reevaluateOnRerun: true };
    const t = await terminal(provider, c, { target: '${input:target}' }, { group: vscode.TaskGroup.Build, presentationOptions, runOptions },
        { type: 'bsp', operation: 'compile', target: 'App', connection: c.config.configPath });
    assert.equal(c.client.calls.length, 0);
    assert.equal(t.task.presentationOptions, presentationOptions); assert.equal(t.task.runOptions, runOptions);
    t.pty.open(); t.pty.open();
    assert.equal(await t.done, 0); assert.equal(c.client.calls.length, 1);
    assert.match(t.output.join(''), /Compiling\r\nSources/);
});

test('context tasks execute once with the chosen build policy and standard tasks build before running', async () => {
    for (const op of ['run', 'test']) {
        const c = connection(`/tasks-${op}`, 'a.json'), { provider } = setup([c]);
        const t = await terminal(provider, c, { operation: op }); t.pty.open();
        assert.equal(await t.done, 0);
        assert.deepEqual(c.client.calls.map(call => call[0]), ['compile', op]);
        c.client.calls.length = 0; c.client.contexts.enabled = true; c.client.contexts.supportsReuse = true;
        const reused = await terminal(provider, c, { operation: op, buildPolicy: 'reuse' }); reused.pty.open();
        assert.equal(await reused.done, 0);
        assert.equal(c.client.calls.length, 1);
        const call = c.client.calls[0]; assert.equal(call[0], 'context'); assert.equal(call[1], op); assert.equal(call[7], 'reuse');
    }
});

test('failed builds, unsupported reuse, and invalid definitions fail tasks before execution', async () => {
    const c = connection('/tasks-errors', 'a.json'), { provider } = setup([c]);
    c.client.compile = async () => { c.client.calls.push(['compile']); return { statusCode: 2 }; };
    const failed = await terminal(provider, c, { operation: 'run' }); failed.pty.open();
    assert.equal(await failed.done, 1); assert.deepEqual(c.client.calls.map(call => call[0]), ['compile']);
    for (const value of [{ operation: 'run', buildPolicy: 'reuse' }, { buildPolicy: 'reuse' }, { operation: 'debug' }, { target: '' }]) {
        c.client.calls.length = 0;
        const t = await terminal(provider, c, value); t.pty.open();
        assert.equal(await t.done, 1); assert.equal(c.client.calls.length, 0);
    }
});

test('cancelling a task cancels only its request and keeps a nonzero result after a late success', async () => {
    const c = connection('/tasks-cancel', 'a.json', [target('App'), target('Other')]), { provider } = setup([c]);
    const requests = [];
    c.client.compile = async (selected, token) => { const d = deferred(); requests.push({ selected, token, ...d }); return d.promise; };
    const a = await terminal(provider, c), b = await terminal(provider, c, { target: 'Other' });
    a.pty.open(); b.pty.open(); await tick();
    a.pty.close(); assert.equal(requests[0].token.isCancellationRequested, true); assert.equal(requests[1].token.isCancellationRequested, false);
    requests[0].resolve({ statusCode: 1 }); requests[1].resolve({ statusCode: 1 });
    assert.equal(await a.done, 130); assert.equal(await b.done, 0);
    const cancelled = await terminal(provider, c); cancelled.pty.close(); cancelled.pty.open();
    assert.equal(await cancelled.done, 130); assert.equal(requests.length, 2);
});

test('launch configuration preparation runs only in the hook after preLaunchTask', async () => {
    const calls = [];
    const provider = new BspDebugConfigurationProvider(async (_folder, _token, options) => {
        calls.push(options); return { type: 'bsp-debug', request: 'attach', name: 'Resolved', connect: { host: 'localhost', port: 23456 } };
    });
    const config = { type: 'bsp-debug', request: 'launch', name: 'Build + Debug', preLaunchTask: 'BSP Build',
        target: '${input:target}', connection: '${workspaceFolder}/.bsp/a.json', buildPolicy: 'reuse' };
    assert.equal(await provider.resolveDebugConfiguration(undefined, config), config);
    assert.equal(calls.length, 0);
    const result = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined,
        { ...config, target: 'App', connection: '/app/.bsp/a.json' });
    assert.equal(calls.length, 1); assert.equal(calls[0].target, 'App'); assert.equal(calls[0].buildPolicy, 'reuse');
    assert.equal(result.request, 'attach'); assert.equal(result.connect.port, 23456);
    assert.equal(result.name, config.name); assert.equal(result.target, undefined); assert.equal(result.connection, undefined);
    assert.equal(result.buildPolicy, undefined);
});

test('explicit launch uses the correct server, stops on failed builds, and rejects unsupported reuse', async () => {
    const a = connection('/launch-one', 'a.json'), b = connection('/launch-two', 'b.json');
    const { resolver } = setup([a, b]);
    await resolver.prepareDebug({ target: 'App', connection: '.bsp/b.json' }, b.folder);
    assert.equal(a.client.calls.length, 0); assert.deepEqual(b.client.calls.map(call => call[0]), ['compile', 'debug']);
    b.client.calls.length = 0;
    b.client.compile = async () => ({ statusCode: 2 });
    await assert.rejects(resolver.prepareDebug({ target: 'App' }, b.folder), /Build failed/);
    assert.equal(b.client.calls.length, 0);
    await assert.rejects(resolver.prepareDebug({ target: 'App', buildPolicy: 'reuse' }, b.folder), /does not support/);
    b.client.contexts.enabled = true; b.client.contexts.supportsReuse = true;
    await resolver.prepareDebug({ target: 'App', buildPolicy: 'reuse' }, b.folder);
    assert.equal(b.client.calls.length, 1); assert.equal(b.client.calls[0][0], 'debug'); assert.equal(b.client.calls[0][3], 'reuse');
});

test('explicit connection reconnects once for concurrent requests and never falls back after failure', async () => {
    const a = connection('/tasks-reconnect', 'a.json'), b = connection('/tasks-reconnect', 'b.json');
    a.client.connected = false;
    const { resolver, manager } = setup([a, b]), connected = deferred();
    let count = 0;
    manager.connectToServer = async id => {
        assert.equal(id, a.id); count++; await connected.promise; a.client.connected = true;
    };
    const options = { connection: '.bsp/a.json', target: 'App' };
    const first = resolver.resolve(options, 'compile', a.folder), second = resolver.resolve(options, 'compile', a.folder);
    await tick(); assert.equal(count, 1); connected.resolve();
    assert.ok((await Promise.all([first, second])).every(choice => choice.connection === a));
    a.client.connected = false;
    manager.connectToServer = async () => { throw new Error('Connection failed'); };
    await assert.rejects(resolver.resolve(options, 'compile', a.folder), /Connection failed/);
    assert.equal(b.client.calls.length, 0);
});

test('each F5 launch requests a fresh endpoint and a cancelled preparation returns quietly', async () => {
    const { CancellationTokenSource } = require('vscode-jsonrpc/node');
    let count = 0;
    const provider = new BspDebugConfigurationProvider(async () => ({
        type: 'bsp-debug', request: 'attach', name: 'App', connect: { host: 'localhost', port: 20000 + ++count }
    }));
    const config = { type: 'bsp-debug', request: 'launch', name: 'Fixed App', target: 'App' };
    for (const port of [20001, 20002]) {
        await provider.resolveDebugConfiguration(undefined, config);
        assert.equal((await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, config)).connect.port, port);
        assert.equal(config.connect, undefined);
    }
    const source = new CancellationTokenSource();
    const cancelled = new BspDebugConfigurationProvider(async () => { source.cancel(); throw new Error('Request cancelled'); });
    assert.equal(await cancelled.resolveDebugConfigurationWithSubstitutedVariables(undefined, config, source.token), null);
    source.dispose();
});

test('background tasks fail and disposing the provider cancels active terminals', async () => {
    const c = connection('/tasks-lifecycle', 'a.json'), { provider } = setup([c]);
    const background = await terminal(provider, c, {}, { isBackground: true }); background.pty.open();
    assert.equal(await background.done, 1); assert.equal(c.client.calls.length, 0);
    const request = deferred(); let token;
    c.client.compile = async (_target, cancellation) => { token = cancellation; return request.promise; };
    const active = await terminal(provider, c); active.pty.open(); await tick();
    provider.dispose(); assert.equal(token.isCancellationRequested, true);
    request.resolve({ statusCode: 1 }); assert.equal(await active.done, 130);
    assert.deepEqual(await provider.provideTasks(CancellationToken.None), []);
});

test('Debug uses the saved Context and build policy without showing a target picker', async () => {
    for (const policy of ['build', 'reuse']) {
        const c = connection(`/debug-context-${policy}`, 'a.json', [target('Hello')], true), { resolver } = setup([c]);
        c.client.contexts.getSelection = () => ({ profile: 'selected' });
        const resolved = { id: 'ctx', operation: 'debug', targets: [target('Hello').id], selection: { profile: 'selected' }, buildPolicy: policy };
        c.client.contexts.resolve = async (scope, operation, token, requestedPolicy) => {
            assert.deepEqual(scope, {}); assert.equal(operation, 'debug'); assert.equal(requestedPolicy, policy);
            c.client.calls.push(['resolve']); return resolved;
        };
        c.client.prepareResolvedDebugConfiguration = async context => {
            assert.equal(context, resolved); c.client.calls.push(['debug-context']);
            return { type: 'bsp-debug', request: 'attach', name: 'Hello', connect: { host: 'localhost', port: 12345 } };
        };
        c.client.getBuildTargets = () => assert.fail('A saved Context must not trigger the target picker');
        assert.equal((await resolver.prepareDebug({ buildPolicy: policy }, c.folder)).connect.port, 12345);
        assert.deepEqual(c.client.calls, [['resolve'], ['debug-context']]);
    }
});

test('Debug without a saved Context picks a target and preserves explicit target precedence', async () => {
    const c = connection('/debug-pick', 'a.json', [target('Hello')], true), { resolver } = setup([c]);
    c.client.contexts.getSelection = () => ({});
    c.client.contexts.resolve = () => assert.fail('Target preparation resolves its own Context');
    const previous = vscode.window.showQuickPick;
    let picks = 0;
    vscode.window.showQuickPick = async (items, options) => { picks++; assert.equal(options.placeHolder, 'Select a build target for Debug'); return items[0]; };
    try {
        await resolver.prepareDebug({}, c.folder);
        c.client.contexts.getSelection = () => ({ profile: 'workspace-choice' });
        await resolver.prepareDebug({ target: 'Hello' }, c.folder);
        assert.equal(picks, 1);
        assert.deepEqual(c.client.calls.map(c => c[0]), ['debug', 'debug']);
        c.client.calls.length = 0;
        c.client.contexts.getSelection = () => ({});
        vscode.window.showQuickPick = async () => undefined;
        assert.equal(await resolver.prepareDebug({}, c.folder), undefined);
        assert.deepEqual(c.client.calls, []);
    } finally { vscode.window.showQuickPick = previous; }
});

test('Debug reports an invalid saved Context without selecting another target', async () => {
    const c = connection('/debug-invalid-context', 'a.json', [target()], true), { resolver } = setup([c]);
    c.client.contexts.getSelection = () => ({ profile: 'stale' });
    c.client.contexts.resolve = async () => { throw new Error('Saved device is unavailable'); };
    await assert.rejects(resolver.prepareDebug({}, c.folder), /Saved device is unavailable/);
    assert.deepEqual(c.client.calls, []);
    c.client.prepareExecutionContext = async () => false;
    assert.equal(await resolver.prepareDebug({}, c.folder), undefined);
    assert.deepEqual(c.client.calls, []);
});


test('Attach uses the saved Context once and bypasses client compilation', async () => {
    const c = connection('/attach-context', 'a.json', [target('Hello')], true), { resolver } = setup([c]);
    c.client.contexts.getSelection = () => ({ profile: 'selected' });
    const resolved = { id: 'ctx', operation: 'debug', targets: [target('Hello').id],
        selection: { profile: 'selected' }, buildPolicy: 'reuse' };
    c.client.contexts.resolve = async (scope, operation, token, policy) => {
        assert.deepEqual(scope, {}); assert.equal(operation, 'debug'); assert.equal(policy, 'reuse');
        c.client.calls.push(['resolve']); return resolved;
    };
    c.client.prepareResolvedDebugConfiguration = async (context, token, request) => {
        assert.equal(context, resolved); assert.equal(request, 'attach');
        c.client.calls.push(['attach']); return { request: 'attach', connect: { host: 'localhost', port: 23456 } };
    };
    c.client.getBuildTargets = () => assert.fail('No target picker for a saved Context');
    assert.equal((await resolver.prepareDebug({ request: 'attach' }, c.folder)).request, 'attach');
    assert.deepEqual(c.client.calls, [['resolve'], ['attach']]);
});

test('Attach falls back to the target picker and never compiles a standard BSP target', async () => {
    const c = connection('/attach-target', 'a.json'), { resolver } = setup([c]);
    const previous = vscode.window.showQuickPick;
    let picks = 0;
    vscode.window.showQuickPick = async (items, options) => {
        picks++; assert.equal(options.placeHolder, 'Select a build target for Attach'); return items[0];
    };
    try {
        await resolver.prepareDebug({ request: 'attach' }, c.folder);
        await resolver.prepareDebug({ request: 'attach', target: 'App' }, c.folder);
        assert.equal(picks, 1);
        assert.deepEqual(c.client.calls.map(call => [call[0], call[4]]), [['debug', 'attach'], ['debug', 'attach']]);
        c.client.calls.length = 0;
        vscode.window.showQuickPick = async () => undefined;
        assert.equal(await resolver.prepareDebug({ request: 'attach' }, c.folder), undefined);
        assert.deepEqual(c.client.calls, []);
    } finally { vscode.window.showQuickPick = previous; }
});
