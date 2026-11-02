const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BspProgress } = require('../out/bspProgress');
const { BspDiagnostics } = require('../out/bspDiagnostics');

test('routes concurrent requests, counts without totals, and child tasks', () => {
    const router = new BspProgress();
    const first = [], second = [];
    router.register('one', update => first.push(update));
    router.register('two', update => second.push(update));
    const unexpected = () => { throw new Error('Unexpected background task'); };
    router.start({ taskId: { id: 'a' }, originId: 'one' }, unexpected);
    router.start({ taskId: { id: 'b' }, originId: 'two' }, unexpected);
    router.progress({ taskId: { id: 'a' }, progress: 2, unit: 'files', message: 'Compiling' });
    assert.deepEqual(first.at(-1), { message: 'Compiling (2 files)' });
    router.progress({ taskId: { id: 'b' }, progress: 30, total: 100 });
    assert.equal(second.at(-1).increment, 30);
    router.start({ taskId: { id: 'child', parents: ['a'] }, message: 'Child' }, unexpected);
    router.progress({ taskId: { id: 'child' }, progress: 1, total: 1, message: 'Child complete' });
    assert.equal(first.at(-1).increment, undefined);
    assert.equal(second.at(-1).increment, 30);
    router.unregister('one');
    const count = first.length;
    router.progress({ taskId: { id: 'child' }, message: 'late' });
    assert.equal(first.length, count);
});

test('percentage increments are finite, bounded and monotonic', () => {
    const router = new BspProgress(), reports = [];
    router.register('one', update => reports.push(update));
    router.start({ taskId: 'legacy-id', originId: 'one' }, () => assert.fail());
    for (const [progress, total] of [[5, 10], [2, 10], [1, 0], [NaN, 10], [50, Infinity], [20, 10]]) {
        router.progress({ taskId: 'legacy-id', progress, total });
    }
    assert.deepEqual(reports.slice(1).map(value => value.increment), [50, 0, undefined, undefined, undefined, 50]);
});

test('background tasks close on finish or disconnect', () => {
    const router = new BspProgress();
    let closed = 0;
    const background = () => ({ report() {}, close() { closed++; } });
    router.start({ taskId: { id: 'index' } }, background);
    router.start({ taskId: { id: 'index-child', parents: ['index'] } }, background);
    router.finish({ taskId: { id: 'index-child' }, status: 1 });
    assert.equal(closed, 0);
    router.finish({ taskId: { id: 'index' }, status: 1 });
    assert.equal(closed, 1);
    router.start({ taskId: { id: 'other' } }, background);
    router.dispose();
    assert.equal(closed, 2);
});

test('reset replaces only one target and duplicate shared diagnostics are merged', () => {
    const store = new BspDiagnostics();
    const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'error' };
    const params = (target, diagnostics, reset = true) => ({ textDocument: { uri: 'file:///A.swift' }, buildTarget: { uri: target }, diagnostics, reset });
    assert.equal(store.update(params('one', [diagnostic])).length, 1);
    assert.equal(store.update(params('two', [diagnostic])).length, 1);
    assert.equal(store.update(params('one', [])).length, 1);
    assert.equal(store.update(params('two', [])).length, 0);
    store.update(params('one', [diagnostic]));
    store.clear();
    assert.equal(store.update(params('two', [])).length, 0);
});

test('client connects task notifications to the request window and sends cancellation', async () => {
    const Module = require('node:module');
    const originalLoad = Module._load;
    const reports = [], errors = [];
    let cancel;
    const debugStarted = new Set(), debugStopped = new Set();
    const debug = {
        activeDebugSession: undefined,
        onDidStartDebugSession: listener => { debugStarted.add(listener); return { dispose: () => debugStarted.delete(listener) }; },
        onDidTerminateDebugSession: listener => { debugStopped.add(listener); return { dispose: () => debugStopped.delete(listener) }; },
        stopDebugging: async session => {
            for (const listener of [...debugStopped]) { listener(session); }
            if (debug.activeDebugSession === session) { debug.activeDebugSession = undefined; }
        }
    };
    const vscode = {
        debug,
        languages: { createDiagnosticCollection: () => ({ clear() {}, set() {} }) },
        window: {
            withProgress: (_options, action) => action({ report: update => reports.push(update) }, {
                isCancellationRequested: false,
                onCancellationRequested: listener => { cancel = listener; return { dispose() {} }; }
            }),
            showInformationMessage() {},
            showErrorMessage: message => errors.push(message),
            setStatusBarMessage() {}
        },
        ProgressLocation: { Notification: 15 }
    };
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    let BspClient;
    try { ({ BspClient } = require('../out/bspClient')); } finally { Module._load = originalLoad; }
    const client = new BspClient({ fsPath: '/project' });
    const handlers = new Map();
    let requestToken;
    client.connection = {
        onNotification: (method, handler) => handlers.set(method, handler),
        sendRequest: async (method, params, token) => {
            assert.equal(method, 'buildTarget/compile');
            requestToken = token;
            handlers.get('build/taskStart')({ taskId: { id: 'compile' }, originId: params.originId });
            handlers.get('build/taskProgress')({ taskId: { id: 'compile' }, message: 'Linking', progress: 2, total: 4 });
            return new Promise(resolve => token.onCancellationRequested(() => {
                handlers.get('build/taskFinish')({ taskId: { id: 'compile' }, status: 3 });
                resolve({ statusCode: 3 });
            }));
        }
    };
    client.setupNotificationHandlers();
    const pending = client.compile({ id: { uri: 'target://app' }, displayName: 'App' });
    assert.equal(reports.find(value => value.message === 'Linking').increment, 50);
    cancel();
    assert.equal(requestToken.isCancellationRequested, true);
    assert.equal((await pending).statusCode, 3);
    assert.equal(client.getActiveRequests().size, 0);
    assert.equal(errors.length, 0);
    const target = { id: { uri: 'target://app' } };
    await assert.rejects(client.getOutputPaths(target), /does not provide/);
    client.serverCapabilities = { outputPathsProvider: true };
    const path = { uri: 'file:///build/Products', kind: 2 };
    client.connection.sendRequest = async (method, params) => {
        assert.equal(method, 'buildTarget/outputPaths');
        assert.deepEqual(params, { targets: [target.id] });
        return { items: [
            { target: target.id, outputPaths: [path, path] },
            { target: { uri: 'target://other' }, outputPaths: [{ uri: 'file:///other', kind: 2 }] }
        ] };
    };
    assert.deepEqual(await client.getOutputPaths(target), [path]);

    const sequence = [];
    const configuration = client.debugSessions.configuration(target.id.uri);
    const session = {
        id: 'debug-hello', type: 'bsp-debug', name: 'Debug Hello', configuration,
        customRequest: async (method, params) => {
            assert.equal(method, 'disconnect');
            assert.deepEqual(params, { terminateDebuggee: true });
            sequence.push('disconnect');
        }
    };
    debug.activeDebugSession = session;
    for (const listener of debugStarted) { listener(session); }
    client.connection.sendRequest = async (method, params) => {
        assert.equal(method, 'buildTarget/run');
        assert.equal(debug.activeDebugSession, undefined);
        sequence.push('run');
        handlers.get('build/taskStart')({ taskId: { id: 'run' }, originId: params.originId });
        handlers.get('build/taskProgress')({ taskId: { id: 'run' }, message: 'Installing Hello' });
        handlers.get('build/taskFinish')({ taskId: { id: 'run' }, status: 1, message: 'Run completed' });
        return { statusCode: 1, originId: params.originId };
    };
    assert.equal((await client.run(target)).statusCode, 1);
    assert.deepEqual(sequence, ['disconnect', 'run']);
    assert.ok(reports.some(report => report.message === 'Installing Hello'));

    let releaseRun;
    client.connection.sendRequest = () => new Promise(resolve => { releaseRun = resolve; });
    const firstRun = client.run(target);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(client.run(target), /already starting/);
    await assert.rejects(client.debug(target), /already starting/);
    releaseRun({ statusCode: 1 });
    await firstRun;

    session.customRequest = async () => { throw new Error('Cannot stop debugger'); };
    debug.activeDebugSession = session;
    client.connection.sendRequest = () => assert.fail('Must not run while stopping debug failed');
    await assert.rejects(client.run(target), /Cannot stop debugger/);
    assert.equal(client.launchRequests.size, 0);
    assert.equal(client.getActiveRequests().size, 0);
    debug.activeDebugSession = undefined;
    client.debugSessions.dispose();
    assert.equal(debugStarted.size, 0);
    assert.equal(debugStopped.size, 0);
});

test('reveals server output paths, supports selection, and handles missing products', async () => {
    const Module = require('node:module');
    const originalLoad = Module._load;
    const revealed = [], messages = [];
    let choose = 1, exists = true;
    const vscode = {
        Uri: { parse: value => {
            const url = new URL(value);
            return { scheme: url.protocol.slice(0, -1), path: decodeURI(url.pathname), fsPath: decodeURI(url.pathname), toString: () => value };
        } },
        workspace: { fs: { stat: async () => { if (!exists) { throw { code: 'FileNotFound' }; } } } },
        commands: { executeCommand: async (command, uri) => { assert.equal(command, 'revealFileInOS'); revealed.push(uri.toString()); } },
        window: {
            showInformationMessage: message => messages.push(message),
            showQuickPick: async items => choose === undefined ? undefined : items[choose]
        }
    };
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    let revealBuildOutput;
    try { ({ revealBuildOutput } = require('../out/outputPaths')); } finally { Module._load = originalLoad; }
    let paths = [{ uri: 'file:///build/Debug/My%20App.app', kind: 2 }];
    const client = { getOutputPaths: async () => paths };
    const target = { id: { uri: 'target://app' } };
    await revealBuildOutput(client, target);
    assert.deepEqual(revealed, ['file:///build/Debug/My%20App.app']);
    paths.push({ uri: 'file:///build/Release', kind: 2 });
    await revealBuildOutput(client, target);
    assert.equal(revealed.at(-1), 'file:///build/Release');
    choose = undefined;
    await revealBuildOutput(client, target);
    assert.equal(revealed.length, 2);
    choose = 0; exists = false;
    await revealBuildOutput(client, target);
    assert.equal(revealed.length, 2);
    assert.match(messages.at(-1), /does not exist yet/);
    paths = [];
    await revealBuildOutput(client, target);
    assert.match(messages.at(-1), /no output paths/);
});
