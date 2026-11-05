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
    const reports = [], errors = [], warnings = [], information = [];
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
            showInformationMessage: message => information.push(message),
            showWarningMessage: message => warnings.push(message),
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
    handlers.get('build/showMessage')({ type: 1, message: 'Test error' });
    handlers.get('build/showMessage')({ type: 2, message: 'Test warning' });
    handlers.get('build/showMessage')({ type: 3, message: 'Test information' });
    assert.deepEqual(errors.splice(0), ['Test error']);
    assert.deepEqual(warnings, ['Test warning']);
    assert.deepEqual(information, ['Test information']);

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

    handlers.get('build/taskStart')({ taskId: { id: 'tests' }, message: 'Run tests' });
    handlers.get('build/taskStart')({ taskId: { id: 'case', parents: ['tests'] }, dataKind: 'test-start', data: { displayName: 'example()' } });
    handlers.get('build/taskFinish')({ taskId: { id: 'case', parents: ['tests'] }, status: 2, dataKind: 'test-finish', data: { displayName: 'example()', status: 2, message: 'Expected 1, got 2' } });
    handlers.get('build/taskFinish')({ taskId: { id: 'tests' }, status: 2, dataKind: 'test-report', data: { target: { uri: 'target://tests' }, passed: 0, failed: 1, ignored: 0, cancelled: 0, skipped: 0, time: 1500 } });
    assert.equal(client.backgroundTasks.active.length, 0);
    assert.equal(client.backgroundTasks.last.status, 2);
    assert.match(client.backgroundTasks.last.message, /0 passed, 1 failed.*1.50s/);

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
    await assert.rejects(client.run(target), /Wait for the current operation/);
    await assert.rejects(client.debug(target), /Wait for the current operation/);
    releaseRun({ statusCode: 1 });
    await firstRun;

    session.customRequest = async () => { throw new Error('Cannot stop debugger'); };
    debug.activeDebugSession = session;
    client.connection.sendRequest = () => assert.fail('Must not run while stopping debug failed');
    await assert.rejects(client.run(target), /Cannot stop debugger/);
    assert.equal(client.operations.get(target.id.uri), undefined);
    assert.equal(client.getActiveRequests().size, 0);
    debug.activeDebugSession = undefined;
    const standardRequests = [];
    client.serverCapabilities.testProvider = { languageIds: ['swift'] };
    const standardTarget = { id: { uri: 'target://standard' }, displayName: 'Standard', capabilities: { canTest: true } };
    client.connection.sendRequest = async (method, params) => {
        standardRequests.push({ method, params });
        return { statusCode: 1 };
    };
    assert.equal((await client.runWithoutBuilding(standardTarget)).statusCode, 1);
    assert.equal((await client.testWithoutBuilding(standardTarget)).statusCode, 1);
    assert.equal(standardRequests.length, 2);
    assert.equal(standardRequests[0].method, 'buildTarget/run');
    assert.deepEqual(Object.keys(standardRequests[0].params).sort(), ['arguments', 'originId', 'target']);
    assert.deepEqual(standardRequests[0].params.target, standardTarget.id);
    assert.deepEqual(standardRequests[0].params.arguments, []);
    assert.equal(standardRequests[0].params.dataKind, undefined);
    assert.equal(standardRequests[1].method, 'buildTarget/test');
    assert.deepEqual(Object.keys(standardRequests[1].params).sort(), ['arguments', 'originId', 'targets']);
    assert.deepEqual(standardRequests[1].params.targets, [standardTarget.id]);
    assert.deepEqual(standardRequests[1].params.arguments, []);
    assert.equal(standardRequests[1].params.dataKind, undefined);
    const nativeEvents = [];
    const nativeSubscription = client.onTestEvent(event => nativeEvents.push(event));
    const nativeCancellation = new (require('vscode-jsonrpc/node').CancellationTokenSource)();
    client.serverCapabilities.testProvider = { languageIds: ['swift'] };
    const testTarget = { id: { uri: 'target://tests' }, capabilities: { canTest: true } };
    client.connection.sendRequest = async (method, params, token) => {
        assert.equal(method, 'buildTarget/test');
        assert.equal(params.dataKind, 'custom-selection');
        assert.deepEqual(params.data, { ids: ['case-1'] });
        return new Promise(resolve => token.onCancellationRequested(() => resolve({ statusCode: 3 })));
    };
    const nativeRequest = client.test(testTarget, { native: true, token: nativeCancellation.token, selection: { dataKind: 'custom-selection', data: { ids: ['case-1'] } } });
    await assert.rejects(client.test(testTarget, { native: true }), /Wait for the current operation/);
    nativeCancellation.cancel();
    assert.equal((await nativeRequest).statusCode, 3);
    assert.deepEqual(nativeEvents.map(event => event.kind), ['started', 'finished']);
    assert.equal(nativeEvents[1].status, 3);
    assert.equal(nativeEvents[0].originId, nativeEvents[1].originId);
    assert.equal(client.getActiveRequests().size, 0);
    client.connection.sendRequest = () => assert.fail('Cancelled tests must not reach the server');
    await client.test(testTarget, { native: true, token: nativeCancellation.token });
    assert.equal(client.operations.get(testTarget.id.uri), undefined);
    nativeSubscription.dispose();
    nativeCancellation.dispose();

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


test('formats BSP test reports and rejects malformed payloads', () => {
    const { testTaskMessage } = require('../out/bspTestReports');
    const message = (dataKind, data) => testTaskMessage({ taskId: { id: 'test' }, dataKind, data });
    assert.equal(message('test-finish', { displayName: 'skip', status: 5 }), 'skip: skipped');
    assert.equal(message('test-finish', { displayName: 'cancel', status: 4 }), 'cancel: cancelled');
    assert.equal(message('test-report', 'base64'), undefined);
    assert.equal(message('test-report', { target: { uri: 'target://t' }, passed: -1 }), undefined);
    assert.equal(message('test-finish', { displayName: 'unknown', status: 123 }), undefined);
    assert.equal(message('custom', {}), undefined);
});
