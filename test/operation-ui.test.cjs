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
const bars = [], notices = [];
let startDebugging = async () => true;
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
        withProgress: (_options, task) => task({ report() {} }, CancellationToken.None),
        showInformationMessage: message => notices.push(message), showErrorMessage() {}, setStatusBarMessage() {},
        createStatusBarItem: () => {
            const bar = { visible: false, show() { this.visible=true; }, hide() { this.visible=false; }, dispose() { this.visible=false; } };
            bars.push(bar); return bar;
        }
    }
};
const load = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let BspClient, MultiBspProvider, BspTreeItem, BspStatusBar, BspDebugConfigurationProvider;
try {
    ({ BspClient } = require('../out/bspClient'));
    ({ MultiBspProvider, BspTreeItem } = require('../out/multiBspProvider'));
    ({ BspStatusBar } = require('../out/bspStatusBar'));
    ({ BspDebugConfigurationProvider } = require('../out/debugProvider'));
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
        assert.equal(await provider.resolveDebugConfiguration(undefined,{}),null);
        assert.match(notices.at(-1),/Wait for the current operation/);
        assert.equal(c.requests.length,1);
        adapter.resolve(false); await assert.rejects(pending,/Failed to start/);
        assert.equal(c.operations.get(t.id.uri),undefined);
    } finally { startDebugging=async()=>true; c.debugSessions.dispose(); }
});

test('normal and favorite rows share busy state while other connections remain enabled', async () => {
    const a=client(), b=client(), m=manager([a,b]);
    const provider=new MultiBspProvider(m,undefined,{onDidChangeConfiguration:()=>({dispose(){}}),canHandle:()=>false});
    const make=(connectionId,favorite=false)=>{ const item=new BspTreeItem('App',1,'buildTarget'); item.connectionId=connectionId; item.buildTarget=target(); item.contextValue='buildTarget'+(favorite?' favorite':''); return item; };
    const row=make('server-0'),favorite=make('server-0',true),other=make('server-1');
    let changes=0;provider.onDidChangeTreeData(()=>changes++);
    const pending=a.compile(target());
    assert.ok(changes>0);
    for(const item of [row,favorite]) {
        const rendered=provider.getTreeItem(item);assert.match(rendered.contextValue,/busy/);assert.equal(rendered.iconPath.id,'loading~spin');
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
