const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { CancellationToken } = require('vscode-jsonrpc/node');
const { BspTargetOperations, TargetBusyError } = require('../out/bspTargetOperations');
const { BspProgress } = require('../out/bspProgress');
const { BspBackgroundTasks } = require('../out/bspBackgroundTasks');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
class Emitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
}
const bars = [], notices = [], warnings = [], errors = [], progressWindows = [], output = [];
let outputShows = 0;
let startDebugging = async () => true;
let confirm = async () => undefined;
let pickOperation = async () => undefined;
const vscode = {
    EventEmitter: Emitter,
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id) { this.id=id; } }, ThemeColor: class { constructor(id) { this.id=id; } },
    StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 },
    languages: { createDiagnosticCollection: () => ({ clear() {} }) },
    workspace: { getWorkspaceFolder: () => ({ uri: { fsPath: '/app' } }), getConfiguration: () => ({ get: () => [] }) },
    debug: { onDidStartDebugSession: () => ({ dispose() {} }), onDidTerminateDebugSession: () => ({ dispose() {} }),
        startDebugging: (...args) => startDebugging(...args) },
    window: {
        showQuickPick: (...args) => pickOperation(...args),
        withProgress: (options, task) => {
            const reports = []; progressWindows.push({ options, reports });
            return task({ report: update => reports.push(update) }, CancellationToken.None);
        },
        showWarningMessage: (...args) => { warnings.push(args); return confirm(...args); },
        showInformationMessage: message => notices.push(message), showErrorMessage: message => errors.push(message), setStatusBarMessage() {},
        createStatusBarItem: () => {
            const bar = { visible: false, show() { this.visible=true; }, hide() { this.visible=false; }, dispose() { this.visible=false; } };
            bars.push(bar); return bar;
        }
    }
};
const load = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let BspClient, MultiBspProvider, BspTreeItem, BspStatusBar, BspDebugConfigurationProvider, cleanBuildCache, cancelConnectionOperation;
try {
    ({ BspClient } = require('../out/bspClient'));
    ({ MultiBspProvider, BspTreeItem } = require('../out/multiBspProvider'));
    ({ BspStatusBar } = require('../out/bspStatusBar'));
    ({ BspDebugConfigurationProvider } = require('../out/debugProvider'));
    ({ cleanBuildCache } = require('../out/cleanCache'));
    ({ cancelConnectionOperation } = require('../out/bspConnectionActivity'));
    require('../out/logger').initializeBuildLogger({ info: message => output.push(message),
        error: message => output.push(message), warn: message => output.push(message), show() { outputShows++; } });
} finally { Module._load = load; }
const target = (id='app') => ({ id: { uri: 'target://' + id }, displayName: id, tags: ['application'], languageIds: ['swift'], dependencies: [], capabilities: { canCompile: true, canTest: true, canRun: true, canDebug: true } });
function client() {
    const c = new BspClient({ fsPath: '/app' }); c.isConnected=true;
    c.serverCapabilities.testProvider={ languageIds: ['swift'] };
    c.requests=[]; c.handlers=new Map();
    c.connection = { sendRequest: (method, params, token) => {
        const response=deferred(); c.requests.push({method,params,token,...response}); return response.promise;
    }, onNotification: (method, handler) => c.handlers.set(method,handler) };
    c.setupNotificationHandlers(); return c;
}
function manager(clients) {
    const changes=new Emitter(), updates=new Emitter(), operations=new Emitter(), background=new Emitter();
    const connections=clients.map((client,i)=>({id:'server-'+i, connected:true, client, config:{name:'Server '+i}}));
    for (const c of clients) { c.operations.onDidChange(()=>operations.fire()); c.backgroundTasks.onDidChange(()=>background.fire()); }
    return { connections, changes, getAllConnections:()=>connections, getConnection:id=>connections.find(c=>c.id===id),
        onDidChangeConnections:changes.event, onDidUpdateTargets:updates.event, onDidChangeOperations:operations.event,
        onDidChangeBackgroundTasks:background.event };
}

test('locks all operations before sending the first request and allows other targets and servers', async () => {
    const c=client(), other=client(), t=target();
    const pending=c.compile(t);
    assert.ok(c.operations.get(t.id.uri));
    for (const action of [()=>c.compile(t),()=>c.run(t),()=>c.test(t,{native:true}),()=>c.debug(t),()=>c.prepareDebugConfiguration(t)]) {
        await assert.rejects(action(), TargetBusyError);
    }
    assert.equal(c.requests.length,1);
    const independent=c.compile(target('other')), server=other.compile(t);
    assert.equal(c.requests.length,2); assert.equal(other.requests.length,1);
    for (const req of [...c.requests,...other.requests]) req.resolve({statusCode:1});
    await Promise.all([pending,independent,server]);
    assert.equal(c.operations.get(t.id.uri),undefined);
});

test('cancel keeps the lock until the response, ignores taskFinish as an unlock, and permits retry', async () => {
    const c=client(),t=target(), pending=c.compile(t), req=c.requests[0];
    c.handlers.get('build/taskStart')({taskId:{id:'root'},originId:req.params.originId,message:'Build'});
    c.handlers.get('build/taskProgress')({taskId:{id:'root'},message:'Linking'});
    assert.equal(c.operations.get(t.id.uri).message,'Linking');
    c.operations.cancel(t.id.uri);
    assert.equal(req.token.isCancellationRequested,true);
    c.handlers.get('build/taskProgress')({taskId:{id:'root'},message:'Late phase'});
    c.handlers.get('build/taskFinish')({taskId:{id:'root'},status:3});
    assert.equal(c.operations.get(t.id.uri).message,'Cancelling…');
    await assert.rejects(c.compile(t),TargetBusyError);
    req.resolve({statusCode:3}); await pending;
    const retry=c.compile(t); c.requests[1].reject(new Error('Server failed'));
    await assert.rejects(retry,/Server failed/);
    assert.equal(c.operations.get(t.id.uri),undefined);
});

test('disconnect clears state and a late completion cannot unlock the next request', async () => {
    const ops=new BspTargetOperations(), old=deferred(), next=deferred();
    const first=ops.run('a','compile',()=>old.promise);
    ops.clear();
    const second=ops.run('a','run',()=>next.promise);
    old.resolve(); await first;
    assert.equal(ops.get('a').kind,'run');
    next.resolve(); await second;
    assert.equal(ops.get('a'),undefined);
});

test('debug stays locked while VS Code connects and repeated F5 returns without a launch.json error', async () => {
    const c=client(), t=target(), adapter=deferred();
    startDebugging=()=>adapter.promise;
    try {
        const pending=c.debug(t); await tick();
        c.requests[0].resolve({uri:'tcp://127.0.0.1:12345'}); await tick();
        assert.equal(c.operations.get(t.id.uri).message,'Connecting debugger');
        const provider=new BspDebugConfigurationProvider(()=>c.prepareDebugConfiguration(t));
        assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined,{}),null);
        assert.match(notices.at(-1),/Wait for the current operation/);
        assert.equal(c.requests.length,1);
        adapter.resolve(false); await assert.rejects(pending,/Failed to start/);
        assert.equal(c.operations.get(t.id.uri),undefined);
    } finally { startDebugging=async()=>true; c.debugSessions.dispose(); }
});

test('normal and favorite rows share busy state while other connections remain enabled', async () => {
    const a=client(), b=client(), m=manager([a,b]);
    const provider=new MultiBspProvider(m);
    const make=(connectionId,favorite=false)=>{ const item=new BspTreeItem('App',1,'buildTarget'); item.connectionId=connectionId; item.buildTarget=target(); item.contextValue='buildTarget'+(favorite?' favorite':''); return item; };
    const row=make('server-0'),favorite=make('server-0',true),other=make('server-1');
    let changes=0;provider.onDidChangeTreeData(()=>changes++);
    const pending=a.compile(target());
    assert.ok(changes>0);
    for(const item of [row,favorite]) {
        const rendered=provider.getTreeItem(item);assert.match(rendered.contextValue,/busy/);assert.notEqual(rendered.iconPath.id,'loading~spin');
    }
    assert.doesNotMatch(provider.getTreeItem(other).contextValue,/busy/);
    a.operations.cancel(target().id.uri);
    assert.match(provider.getTreeItem(row).contextValue,/cancelling/);
    a.requests[0].resolve({statusCode:3}); await pending;
    assert.doesNotMatch(provider.getTreeItem(row).contextValue,/busy/);
    const manifest=require('../package.json');
    const menus=manifest.contributes.menus['view/item/context'];
    for(const command of ['bsp.compile','bsp.test','bsp.run','bsp.debug']) {
        assert.match(menus.find(item=>item.command===command).when,/!\(viewItem =~ \/busy\/\)/);
    }
    for(const command of ['bsp.runWithoutBuilding','bsp.testWithoutBuilding','bsp.debugWithoutBuilding']) {
        assert.match(menus.find(item=>item.command===command).when,/busy/);
    }
});

test('index preparation status uses server progress, keeps parent tasks alive, and handles failure and disconnect', () => {
    const c=client(),m=manager([c]),status=new BspStatusBar(m),bar=bars.at(-1);
    try {
        assert.equal(bar.visible,false);
        const send=(method,params)=>c.handlers.get(method)(params);
        send('build/taskStart',{taskId:{id:'index'},message:'Prepare indexing'});
        assert.equal(bar.text,'$(sync~spin) BSP: Prepare indexing');
        assert.equal(bar.command,'bsp.showBuildOutput');
        send('build/taskProgress',{taskId:{id:'index'},message:'Preparing modules',progress:2,total:5});
        assert.match(bar.text,/40%/);assert.match(bar.tooltip,/Preparing modules/);
        send('build/taskStart',{taskId:{id:'child',parents:['index']},message:'Module A'});
        send('build/taskFinish',{taskId:{id:'child'},status:1});
        assert.match(bar.text,/sync~spin/);assert.equal(c.backgroundTasks.active.length,1);
        send('build/taskFinish',{taskId:{id:'index'},status:2,message:'Missing dependency'});
        assert.match(bar.text,/Prepare indexing failed/);assert.match(bar.tooltip,/Missing dependency/);
        assert.equal(bar.backgroundColor.id,'statusBarItem.warningBackground');
        c.clearTaskState();assert.equal(bar.visible,false);
    } finally { status.dispose(); }
});

test('simultaneous background tasks from different servers remain distinct and build requests are not background tasks', async () => {
    const a=client(),b=client(),m=manager([a,b]),status=new BspStatusBar(m),bar=bars.at(-1);
    try {
        for(const c of [a,b]) c.handlers.get('build/taskStart')({taskId:'same-id',message:'Prepare indexing'});
        assert.match(bar.text,/2 background tasks/);
        a.handlers.get('build/taskFinish')({taskId:'same-id',status:1});
        assert.match(bar.text,/sync~spin/);assert.match(bar.tooltip,/Server 1/);
        b.handlers.get('build/taskFinish')({taskId:'same-id',status:1});
        assert.match(bar.text,/completed/);
        const pending=a.compile(target()); const req=a.requests[0];
        a.handlers.get('build/taskStart')({taskId:'compile',originId:req.params.originId,message:'Compile'});
        assert.equal(a.backgroundTasks.active.length,0);
        req.resolve({statusCode:1});await pending;
    } finally { status.dispose(); }
});

test('clean uses standard params, locks every target, and reports the server result', async () => {
    const c = client(), other = client(), t = target(), second = target('tests');
    const pending = c.cleanCache(t);
    assert.equal(c.requests.length, 1);
    assert.equal(c.requests[0].method, 'buildTarget/cleanCache');
    assert.deepEqual(c.requests[0].params, { targets: [t.id] });
    assert.equal(progressWindows.at(-1).options.cancellable, false);
    assert.equal(progressWindows.at(-1).options.title, 'BSP: Clean Build Cache');
    assert.deepEqual(progressWindows.at(-1).reports, [{ message: 'Cleaning build cache' }]);
    assert.equal(c.operations.get(second.id.uri), c.operations.get(t.id.uri));
    for (const action of [() => c.cleanCache(second), () => c.compile(second), () => c.test(second, { native: true }),
        () => c.run(second), () => c.debug(second), () => c.prepareDebugConfiguration(second), () => c.reload()]) {
        await assert.rejects(action(), TargetBusyError);
    }
    c.operations.cancel(t.id.uri);
    assert.equal(c.operations.get(t.id.uri).cancelling, false);
    const independent = other.compile(t);
    other.requests[0].resolve({ statusCode: 1 }); await independent;
    c.requests[0].resolve({ cleaned: true, message: 'Removed shared caches' });
    assert.equal((await pending).cleaned, true);
    assert.equal(c.operations.get(second.id.uri), undefined);
    assert.match(notices.at(-1), /Build cache cleaned/);
    assert.match(output.at(-1), /Removed shared caches/);
    const retry = c.compile(second); c.requests[1].resolve({ statusCode: 1 }); await retry;
});

test('clean rejects work on another target, including cancelled requests that have not settled', async () => {
    const c = client(), t = target(), pending = c.compile(t);
    await assert.rejects(c.cleanCache(target('tests')), TargetBusyError);
    c.operations.cancel(t.id.uri);
    await assert.rejects(c.cleanCache(target('tests')), TargetBusyError);
    assert.equal(c.requests.length, 1);
    c.requests[0].resolve({ statusCode: 3 }); await pending;
    const clean = c.cleanCache(t); c.requests[1].resolve({ cleaned: true }); await clean;
});

test('background indexing hides Clean for all targets and restores it only when the root task ends', async () => {
    const c = client(), m = manager([c]);
    const provider = new MultiBspProvider(m);
    const item = new BspTreeItem('App', 1, 'buildTarget');
    item.connectionId = 'server-0'; item.buildTarget = target(); item.contextValue = 'buildTarget favorite';
    let updates = 0; provider.onDidChangeTreeData(() => updates++);
    assert.match(provider.getTreeItem(item).contextValue, /canCleanCache/);
    c.handlers.get('build/taskStart')({ taskId: { id: 'index' }, message: 'Prepare indexing' });
    assert.ok(updates > 0);
    assert.doesNotMatch(provider.getTreeItem(item).contextValue, /canCleanCache/);
    await assert.rejects(c.cleanCache(target()), /Prepare indexing/);
    c.handlers.get('build/taskStart')({ taskId: { id: 'child', parents: ['index'] } });
    c.handlers.get('build/taskFinish')({ taskId: { id: 'child' }, status: 1 });
    await assert.rejects(c.cleanCache(target()), TargetBusyError);
    assert.equal(c.requests.length, 0);
    c.handlers.get('build/taskFinish')({ taskId: { id: 'index' }, status: 1 });
    assert.match(provider.getTreeItem(item).contextValue, /canCleanCache/);
});

test('clean needs confirmation, ignores duplicate dialogs, and rechecks operations after approval', async () => {
    const c = client(), t = target(), choice = deferred();
    confirm = () => choice.promise;
    try {
        const before = warnings.length, pending = cleanBuildCache(c, t);
        await cleanBuildCache(c, target('tests'));
        assert.equal(warnings.length, before + 1);
        assert.equal(warnings.at(-1)[1].modal, true);
        assert.match(warnings.at(-1)[1].detail, /other targets/);
        assert.equal(c.requests.length, 0);
        const compile = c.compile(target('tests'));
        choice.resolve('Clean Build Cache'); await pending;
        assert.equal(c.requests.length, 1);
        assert.match(notices.at(-1), /Cannot clean/);
        c.requests[0].resolve({ statusCode: 1 }); await compile;
        confirm = async () => undefined;
        await cleanBuildCache(c, t);
        assert.equal(c.requests.length, 1);
        confirm = async () => 'Clean Build Cache';
        const retry = cleanBuildCache(c, t); await tick();
        c.requests[1].resolve({ cleaned: true }); await retry;
    } finally { confirm = async () => undefined; }
});

test('confirmation rechecks indexing and disconnects before it sends a clean request', async () => {
    for (const duringDialog of ['index', 'disconnect']) {
        const c = client(), choice = deferred(); confirm = () => choice.promise;
        try {
            const pending = cleanBuildCache(c, target());
            if (duringDialog === 'index') {
                c.handlers.get('build/taskStart')({ taskId: { id: 'index' }, message: 'Prepare indexing' });
            } else { c.isConnected = false; c.clearTaskState(); }
            choice.resolve('Clean Build Cache'); await pending;
            assert.equal(c.requests.length, 0);
            assert.match(notices.at(-1), duringDialog === 'index' ? /Cannot clean/ : /not connected/);
        } finally { confirm = async () => undefined; c.clearTaskState(); }
    }
});

test('false, invalid, unsupported, and rejected clean results report failure and release the lock', async () => {
    for (const response of [
        { result: { cleaned: false, message: 'Cache is in use' }, expected: /Cache is in use/ },
        { result: { message: 'Done' }, expected: /Done/ },
        { error: Object.assign(new Error('Method not found'), { code: -32601 }), expected: /does not support/ },
        { error: new Error('Server disconnected'), expected: /Server disconnected/ }
    ]) {
        const c = client(), count = notices.length, pending = c.cleanCache(target());
        if (response.error) { c.requests[0].reject(response.error); }
        else { c.requests[0].resolve(response.result); }
        await assert.rejects(pending, response.expected);
        assert.match(errors.at(-1), response.expected);
        assert.match(output.at(-1), /Clean failed/);
        assert.equal(notices.length, count);
        assert.equal(c.operations.get(target('tests').id.uri), undefined);
        const retry = c.cleanCache(target()); c.requests[1].resolve({ cleaned: true }); await retry;
    }
});

test('disconnect and a late clean response cannot release a new exclusive operation', async () => {
    const ops = new BspTargetOperations(), old = deferred(), next = deferred();
    const first = ops.run('app', 'clean', () => old.promise);
    ops.clear();
    const second = ops.run('tests', 'clean', () => next.promise);
    old.resolve(); await first;
    assert.equal(ops.get('another').kind, 'clean');
    await assert.rejects(ops.run('another', 'compile', () => Promise.resolve()), TargetBusyError);
    next.resolve(); await second;
    assert.equal(ops.get('another'), undefined);
});

test('clean state appears on normal and favorite rows with no cancel action', async () => {
    const c = client(), other = client(), m = manager([c, other]);
    const provider = new MultiBspProvider(m);
    const make = (server, favorite) => {
        const item = new BspTreeItem('Tests', 1, 'buildTarget');
        item.connectionId = server; item.buildTarget = target('tests'); item.contextValue = 'buildTarget' + (favorite ? ' favorite' : '');
        return item;
    };
    const pending = c.cleanCache(target());
    for (const favorite of [false, true]) {
        const row = provider.getTreeItem(make('server-0', favorite));
        assert.match(row.contextValue, /busy nonCancellable/);
        assert.doesNotMatch(row.contextValue, /canCleanCache/);
        assert.equal(row.description, 'Cleaning build cache');
    }
    assert.match(provider.getTreeItem(make('server-1', false)).contextValue, /canCleanCache/);
    const manifest = require('../package.json'), menus = manifest.contributes.menus['view/item/context'];
    assert.equal(manifest.contributes.commands.find(c => c.command === 'bsp.cleanCache').title, 'Clean Build Cache…');
    const cleanMenu = menus.find(m => m.command === 'bsp.cleanCache');
    assert.doesNotMatch(cleanMenu.group, /inline/);
    assert.match(cleanMenu.when, /canCleanCache/);
    assert.equal(menus.some(m => m.command === 'bsp.cancelOperation'), false);
    assert.match(menus.find(m => m.command === 'bsp.cancelConnectionOperation').when, /canCancel/);
    c.requests[0].resolve({ cleaned: true }); await pending;
    assert.match(provider.getTreeItem(make('server-0', true)).contextValue, /canCleanCache/);
});

test('target details show dependencies and languages without retired selectors', async () => {
    const contextual = client(), standard = client();
    contextual.contexts.negotiate({ bspExtensions: { 'vscode-bsp.build-context': {
        version: '0.1', required: true, operations: ['compile', 'run', 'test', 'debug']
    } } });
    const provider = new MultiBspProvider(manager([contextual, standard]));
    for (const connectionId of ['server-0', 'server-1']) {
        const item = new BspTreeItem('App', vscode.TreeItemCollapsibleState.Collapsed, 'buildTarget');
        item.connectionId = connectionId;
        item.buildTarget = { ...target(), dependencies: [{ uri: 'target://library' }], data: {
            selectors: [{ keyName: 'Configuration', displayLabel: 'Select Configuration',
                values: [{ displayName: 'Debug', arguments: ['-configuration', 'Debug'] }] }]
        } };
        const children = await provider.getChildren(item);
        assert.deepEqual(children.map(child => child.type), ['dependencies', 'languages']);
        assert.doesNotMatch(provider.getTreeItem(item).description, /Debug|Configuration|Generic/);
    }
    const { contributes } = require('../package.json');
    assert.ok(contributes.commands.every(command => command.command !== 'bsp.handleDynamicSelector'));
    assert.ok(Object.values(contributes.menus).flat().every(item => item.command !== 'bsp.handleDynamicSelector'));
});


test('Without Building menus require reuse support for contexts and retain legacy actions', () => {
    const c = client(), provider = new MultiBspProvider(manager([c]));
    c.serverCapabilities.runProvider = { languageIds: ['swift'] };
    c.serverCapabilities.debugProvider = { languageIds: ['swift'] };
    const descriptor = { version: '0.1', required: true, operations: ['run', 'test', 'debug'] };
    const row = new BspTreeItem('App', 1, 'buildTarget');
    row.connectionId = 'server-0'; row.buildTarget = target();
    const show = () => provider.getTreeItem(row).contextValue;
    assert.doesNotMatch(show(), /supportsBuildContext|canReuseBuild/);
    c.contexts.negotiate({ bspExtensions: { 'vscode-bsp.build-context': descriptor } });
    assert.match(show(), /supportsBuildContext/);
    assert.doesNotMatch(show(), /canReuseBuild/);
    c.contexts.negotiate({ bspExtensions: { 'vscode-bsp.build-context': {
        ...descriptor, buildPolicies: ['build', 'reuse']
    } } });
    assert.match(show(), /supportsBuildContext.*canReuseBuild/);
    const menus = require('../package.json').contributes.menus['view/item/context'];
    for (const action of ['Run', 'Test', 'Debug']) {
        const targetMenu = menus.find(item => item.command === `bsp.${action.toLowerCase()}WithoutBuilding`);
        assert.match(targetMenu.when, new RegExp(`can${action}`));
        assert.match(targetMenu.when, /!\(viewItem =~ \/supportsBuildContext\/\) \|\| viewItem =~ \/canReuseBuild\//);
        assert.match(targetMenu.when, /disconnected\|loading\|busy/);
        assert.match(targetMenu.group, /advanced/);
        const contextMenu = menus.find(item => item.command === `bsp.context${action}WithoutBuilding`);
        assert.match(contextMenu.when, new RegExp(`buildContextScope.*can${action}`));
        assert.match(contextMenu.when, /canReuseBuild/);
        assert.match(contextMenu.group, /advanced/);
    }
});

test('task terminals isolate request output and cancellation without revealing Output', async () => {
    const { CancellationTokenSource } = require('vscode-jsonrpc/node');
    const c = client(), a = [], b = [], source = new CancellationTokenSource();
    const before = { windows: progressWindows.length, errors: errors.length, notices: notices.length, shown: outputShows };
    const first = c.compile(target('one'), source.token, { native: true, onOutput: line => a.push(line) });
    const second = c.run(target('two'), undefined, { native: true, onOutput: line => b.push(line) });
    await tick();
    const [one, two] = c.requests;
    const send = (method, params) => c.handlers.get(method)(params);
    send('build/taskStart', { taskId: { id: 'one' }, originId: one.params.originId, message: 'Build one' });
    send('build/taskStart', { taskId: { id: 'child', parents: ['one'] }, message: 'Compile child' });
    send('build/taskProgress', { taskId: { id: 'child' }, message: 'Child progress' });
    send('build/logMessage', { originId: one.params.originId, type: 1, message: 'Error one' });
    send('build/logMessage', { originId: two.params.originId, type: 3, message: 'Output two' });
    send('build/logMessage', { type: 3, message: 'Unattributed output' });
    assert.ok(a.includes('Child progress')); assert.ok(a.includes('Error one'));
    assert.ok(b.includes('Output two'));
    assert.ok(!b.includes('Error one')); assert.ok(!a.includes('Output two'));
    assert.ok(!a.includes('Unattributed output') && !b.includes('Unattributed output'));
    assert.ok(output.includes('Unattributed output'));
    source.cancel();
    assert.equal(one.token.isCancellationRequested, true); assert.equal(two.token.isCancellationRequested, false);
    one.resolve({ statusCode: 3 }); two.resolve({ statusCode: 1 }); await Promise.all([first, second]);
    assert.deepEqual({ windows: progressWindows.length, errors: errors.length, notices: notices.length, shown: outputShows }, before);
    const lengths = [a.length, b.length];
    send('build/logMessage', { originId: one.params.originId, type: 3, message: 'Late one' });
    send('build/taskProgress', { taskId: { id: 'child' }, message: 'Late child' });
    assert.deepEqual([a.length, b.length], lengths);
    const failed = c.compile(target('one'), undefined, { native: true, onOutput: line => a.push(line) });
    c.requests[2].reject(new Error('Transport failed')); await assert.rejects(failed, /Transport failed/);
    const count = a.length;
    send('build/logMessage', { originId: c.requests[2].params.originId, type: 3, message: 'Late failure' });
    assert.equal(a.length, count);
    source.dispose(); c.debugSessions.dispose();
});

test('task tests retain native Testing events in standard and context modes', async () => {
    for (const context of [false, true]) {
        const c = client(), events = [], messages = [], selected = target('tests');
        c.onTestEvent(event => events.push(event));
        if (context) {
            c.contexts.negotiate({ bspExtensions: { 'vscode-bsp.build-context': {
                version: '0.1', required: true, operations: ['test'], buildPolicies: ['build', 'reuse']
            } } });
        }
        const sendRequest = c.connection.sendRequest;
        c.connection.sendRequest = (method, params, token) => method === 'workspace/contextOptions'
            ? Promise.resolve({ dimensions: [], selection: {} }) : sendRequest(method, params, token);
        const pending = c.test(selected, { native: true, onOutput: message => messages.push(message) });
        if (context) {
            await tick();
            assert.equal(c.requests[0].method, 'workspace/resolveContext');
            c.requests[0].resolve({ id: 'test-context', operation: 'test', targets: [selected.id], selection: {} });
            await tick();
        }
        const request = c.requests.at(-1);
        assert.equal(request.method, 'buildTarget/test');
        const { originId } = request.params;
        c.handlers.get('build/logMessage')({ originId, type: 3, message: 'Test output' });
        request.resolve({ statusCode: 1 }); await pending;
        assert.ok(events.some(event => event.kind === 'started' && event.originId === originId));
        assert.ok(events.some(event => event.kind === 'finished' && event.originId === originId && event.status === 1));
        assert.ok(messages.includes('Test output'));
        c.debugSessions.dispose();
    }
});

test('Debug executes the resolved Context once and returns its configuration to F5', async () => {
    const c = client(), selected = target('hello'), requests = [];
    c.buildTargets = [selected];
    c.contexts.negotiate({ bspExtensions: { 'vscode-bsp.build-context': {
        version: '0.1', required: true, operations: ['debug'], buildPolicies: ['build', 'reuse']
    } } });
    c.prepareExecutionContext = () => assert.fail('Context must not be prepared twice');
    c.contexts.resolve = () => assert.fail('Context must not be resolved twice');
    c.connection.sendRequest = async (method, params) => {
        requests.push({ method, params });
        assert.equal(method, 'debugSession/start');
        assert.deepEqual(params.targets, [selected.id]);
        assert.deepEqual(params.executionContext, { id: 'resolved-context' });
        return { uri: 'tcp://127.0.0.1:23456', dataKind: 'lldb', data: { request: 'attach', pid: 12 } };
    };
    const result = await c.prepareResolvedDebugConfiguration({ id: 'resolved-context', operation: 'debug',
        targets: [selected.id], selection: { profile: 'selected' }, buildPolicy: 'reuse' });
    assert.equal(result.connect.port, 23456); assert.equal(result.pid, 12);
    assert.equal(requests.length, 1);
});


test('Attach reuses its resolved Context without stopping a session or adding BSP payloads', async () => {
    const c = client(), selected = target('hello'), requests = [];
    c.buildTargets = [selected];
    c.contexts.negotiate({ bspExtensions: { 'vscode-bsp.build-context': {
        version: '0.1', required: true, operations: ['debug'], buildPolicies: ['build', 'reuse']
    } } });
    c.prepareExecutionContext = () => assert.fail('Context must not be prepared twice');
    c.contexts.resolve = () => assert.fail('Context must not be resolved twice');
    c.stopPreviousDebugSession = () => assert.fail('Attach must preserve the running process');
    c.connection.sendRequest = async (method, params) => {
        requests.push({ method, params });
        assert.equal(method, 'debugSession/start');
        assert.deepEqual(Object.keys(params).sort(), ['executionContext', 'originId', 'targets']);
        assert.deepEqual(params.executionContext, { id: 'resolved-context' });
        return { uri: 'tcp://127.0.0.1:23456' };
    };
    try {
        const result = await c.prepareResolvedDebugConfiguration({ id: 'resolved-context', operation: 'debug',
            targets: [selected.id], selection: { profile: 'selected' }, buildPolicy: 'reuse' }, undefined, 'attach');
        assert.equal(result.request, 'attach'); assert.equal(result.bspAttach, true);
        assert.equal(result.connect.port, 23456); assert.equal(requests.length, 1);
    } finally { c.debugSessions.dispose(); }
});

test('connection headers show request progress without Build Context and keep cancellation pending', async () => {
    const c = client(), other = client(), provider = new MultiBspProvider(manager([c, other]));
    const [header, idle] = await provider.getChildren();
    const pending = c.compile(target()), request = c.requests[0];
    let rendered = provider.getTreeItem(header);
    assert.equal(rendered.description, 'Building');
    assert.equal(rendered.iconPath.id, 'loading~spin');
    assert.match(rendered.contextValue, /canCancel/);
    assert.doesNotMatch(provider.getTreeItem(idle).contextValue, /busy/);
    c.operations.includeTargets(target().id.uri, ['target://dependency']);
    c.handlers.get('build/taskStart')({ taskId: { id: 'build' }, originId: request.params.originId, message: 'Build app' });
    c.handlers.get('build/taskProgress')({ taskId: { id: 'build' }, progress: 2, total: 5 });
    assert.equal(provider.getTreeItem(header).description, 'Build app · 40%');
    assert.equal(c.operations.entries.length, 1);
    c.handlers.get('build/taskStart')({ taskId: { id: 'child', parents: ['build'] }, message: 'Compile dependency' });
    c.handlers.get('build/taskProgress')({ taskId: { id: 'child' }, progress: 9, total: 10 });
    assert.equal(provider.getTreeItem(header).description, 'Compile dependency · 40%');
    await cancelConnectionOperation(c);
    assert.equal(request.token.isCancellationRequested, true);
    rendered = provider.getTreeItem(header);
    assert.equal(rendered.description, 'Cancelling…');
    assert.match(rendered.contextValue, /busy/);
    assert.doesNotMatch(rendered.contextValue, /canCancel/);
    c.handlers.get('build/taskFinish')({ taskId: { id: 'build' }, status: 3 });
    assert.match(provider.getTreeItem(header).contextValue, /busy/);
    request.resolve({ statusCode: 3 }); await pending;
    assert.equal(provider.getTreeItem(header).contextValue, 'connectedBspServer');
    assert.equal(header.iconPath.id, 'server-environment');
    provider.dispose();
});

test('connection cancellation selects one operation or all and never cancels a replacement', async () => {
    const c = client(), other = client(), provider = new MultiBspProvider(manager([c]));
    c.buildTargets = [target('one'), target('two')];
    const pending = [c.compile(target('one')), c.compile(target('two')), other.compile(target('one'))];
    const [header] = await provider.getChildren();
    assert.equal(header.description, '2 tasks running');
    pickOperation = async choices => choices.find(choice => choice.label === 'two');
    try {
        await cancelConnectionOperation(c);
        assert.equal(c.requests[0].token.isCancellationRequested, false);
        assert.equal(c.requests[1].token.isCancellationRequested, true);
        assert.equal(other.requests[0].token.isCancellationRequested, false);
        for (const request of [...c.requests, ...other.requests]) { request.resolve({ statusCode: 3 }); }
        await Promise.all(pending);
        const first = c.compile(target('one')), second = c.compile(target('two')), choice = deferred();
        let staleChoices;
        pickOperation = choices => { staleChoices = choices; return choice.promise; };
        const cancelling = cancelConnectionOperation(c);
        c.requests[2].resolve({ statusCode: 1 }); await first;
        const replacement = c.compile(target('one'));
        choice.resolve(staleChoices.find(choice => choice.label === 'Cancel all operations'));
        await cancelling;
        assert.equal(c.requests[3].token.isCancellationRequested, true);
        assert.equal(c.requests[4].token.isCancellationRequested, false);
        c.requests[3].resolve({ statusCode: 3 }); c.requests[4].resolve({ statusCode: 1 });
        await Promise.all([second, replacement]);
    } finally { pickOperation = async () => undefined; provider.dispose(); }
});

test('connection headers show background progress and clean status without a cancel action', async () => {
    const c = client(), provider = new MultiBspProvider(manager([c]));
    const [header] = await provider.getChildren();
    const send = (method, params) => c.handlers.get(method)(params);
    send('build/taskStart', { taskId: { id: 'index' }, message: 'Prepare indexing' });
    send('build/taskProgress', { taskId: { id: 'index' }, progress: 1, total: 4 });
    assert.equal(provider.getTreeItem(header).description, 'Prepare indexing · 25%');
    assert.doesNotMatch(header.contextValue, /canCancel/);
    const pending = c.compile(target());
    assert.equal(provider.getTreeItem(header).description, '2 tasks running');
    await cancelConnectionOperation(c);
    assert.equal(c.requests[0].token.isCancellationRequested, true);
    assert.equal(c.backgroundTasks.active.length, 1);
    c.requests[0].resolve({ statusCode: 3 }); await pending;
    send('build/taskFinish', { taskId: { id: 'index' }, status: 1 });
    const clean = c.cleanCache(target());
    assert.equal(provider.getTreeItem(header).description, 'Cleaning build cache');
    assert.doesNotMatch(header.contextValue, /canCancel/);
    await cancelConnectionOperation(c);
    assert.equal(c.operations.first.cancelling, false);
    c.requests[1].resolve({ cleaned: true }); await clean;
    provider.dispose();
});
