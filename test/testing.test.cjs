const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { CancellationTokenSource, CancellationToken } = require('vscode-jsonrpc/node');

class Collection extends Map {
    constructor(parent) { super(); this.parent = parent; }
    add(item) { item.parent = this.parent; this.set(item.id, item); }
    replace(items) { for (const item of this.values()) { item.parent = undefined; } this.clear(); items.forEach(item => this.add(item)); }
}
const controllers = [];
class Range {
    constructor(line, character, endLine, endCharacter) {
        this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
    }
}
const vscode = {
    tests: { createTestController: () => {
        const controller = {
            items: new Collection(), runs: [],
            createTestItem(id, label, uri) { const item = { id, label, uri, tags: [] }; item.children = new Collection(item); return item; },
            createRunProfile(_label, _kind, handler, _default, tag) { this.handler = handler; this.tag = tag; },
            createTestRun(request) {
                const source = new CancellationTokenSource();
                const run = { request, source, token: source.token, records: [], ended: 0,
                    end() { assert.equal(this.ended++, 0, 'Run ended twice'); }
                };
                for (const method of ['enqueued', 'started', 'passed', 'failed', 'errored', 'skipped', 'appendOutput']) {
                    run[method] = (...args) => { assert.equal(run.ended, 0, 'Result sent after run.end'); run.records.push([method, ...args]); };
                }
                this.runs.push(run); return run;
            },
            dispose() { this.disposed = true; }
        };
        controllers.push(controller); return controller;
    } },
    TestTag: class { constructor(id) { this.id = id; } },
    TestRunRequest: class { constructor(include, exclude) { this.include = include; this.exclude = exclude; } },
    TestRunProfileKind: { Run: 1 },
    TestMessage: class { constructor(message) { this.message = message; } },
    Uri: { file: path => ({ toString: () => 'file://' + path }), parse: uri => ({ toString: () => uri }) },
    Range,
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } }
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
let BspTesting;
try { ({ BspTesting } = require('../out/bspTesting')); } finally { Module._load = originalLoad; }

function emitter() {
    const listeners = new Set();
    return { listeners, event: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
        fire: value => { for (const listener of [...listeners]) { listener(value); } } };
}
function target(name = 'Tests', canTest = true) {
    return { id: { uri: 'target://' + name }, displayName: name, capabilities: { canTest } };
}
function client(targets = [target()]) {
    const events = emitter(); let number = 0;
    return {
        connected: true, supportsTesting: true, targets, events, calls: [],
        onTestEvent: events.event,
        async getBuildTargets() { events.fire({ kind: 'targets' }); return this.targets; },
        emit(event) { events.fire(event); },
        async test(target, options = {}) {
            const originId = `request-${++number}`;
            this.calls.push({ target, options, originId });
            let cancelled = false;
            this.emit({ kind: 'started', originId, target, cancel: () => { cancelled = true; } });
            const status = this.execute ? await this.execute(originId, options) : 1;
            this.emit({ kind: 'finished', originId, status: cancelled ? 3 : status });
            return { statusCode: cancelled ? 3 : status };
        }
    };
}
function setup(clients = [client()]) {
    const changes = emitter(), updates = emitter();
    const connections = clients.map((client, index) => ({ id: `server-${index}`, connected: true, client, config: { name: `server-${index}` } }));
    const manager = { getAllConnections: () => connections, onDidChangeConnections: changes.event, onDidUpdateTargets: updates.event };
    const testing = new BspTesting(manager);
    const controller = testing.controller;
    const targets = () => [...controller.items.values()].flatMap(group => [...group.children.values()]);
    return { testing, controller, clients, connections, changes, updates, targets };
}
function start(client, originId, id = 'root') {
    client.emit({ kind: 'taskStart', params: { taskId: { id }, originId } });
    client.emit({ kind: 'taskStart', params: { taskId: { id: 'group', parents: [id] }, dataKind: 'test-task', data: { target: target().id } } });
}
function result(client, id, name, status, extra = {}) {
    client.emit({ kind: 'taskStart', params: { taskId: { id, parents: ['group'] }, dataKind: 'test-start', data: { displayName: name, ...extra }, eventTime: 1000 } });
    client.emit({ kind: 'taskFinish', params: { taskId: { id, parents: ['group'] }, status: status === 2 ? 2 : 1, dataKind: 'test-finish', data: { displayName: name, status, ...extra }, eventTime: 1250 } });
}
function report(client, counts = { passed: 1, failed: 0, ignored: 0, cancelled: 0, skipped: 0 }) {
    client.emit({ kind: 'taskFinish', params: { taskId: { id: 'group', parents: ['root'] }, status: 1, dataKind: 'test-report', data: { target: target().id, ...counts, time: 1500 } } });
}
const request = (include, exclude) => new vscode.TestRunRequest(include, exclude);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('discovers only testable targets and refreshes connections without merging equal URIs', async () => {
    const a = client([target(), target('App', false)]), b = client();
    const s = setup([a, b]);
    assert.equal(s.targets().length, 2);
    assert.notEqual(s.targets()[0].id, s.targets()[1].id);
    a.targets = [target('NewTests')]; s.updates.fire('server-0');
    assert.deepEqual(s.targets().map(t => t.label), ['NewTests', 'Tests']);
    b.supportsTesting = false; s.changes.fire();
    assert.deepEqual(s.targets().map(t => t.label), ['NewTests']);
    s.connections.splice(0, 1); s.changes.fire();
    assert.equal(a.events.listeners.size, 0);
    s.testing.dispose(); assert.equal(b.events.listeners.size, 0);
});

test('maps standard test payloads, locations, output, and summaries to the native run', async () => {
    const s = setup(), c = s.clients[0], item = s.targets()[0];
    c.execute = async originId => {
        start(c, originId);
        result(c, 'a', 'example', 1);
        result(c, 'b', 'example', 2, { message: 'Expected 1, got 2', location: { uri: 'file:///Tests.swift', range: { start: { line: 4, character: 1 }, end: { line: 4, character: 4 } } } });
        result(c, 'c', 'skip', 5); result(c, 'd', 'ignore', 3);
        report(c, { passed: 1, failed: 1, skipped: 1, ignored: 1, cancelled: 0 });
        c.emit({ kind: 'taskFinish', params: { taskId: { id: 'root' }, originId, status: 2 } });
        assert.equal(s.controller.runs[0].ended, 0, 'Root task finish must not close the request early');
        c.emit({ kind: 'log', params: { originId, message: 'runner output\nsecond line' } });
        return 2;
    };
    await s.controller.handler(request([item]), CancellationToken.None);
    const run = s.controller.runs[0], cases = [...item.children.values()];
    assert.equal(run.ended, 1); assert.equal(cases.length, 4);
    assert.notEqual(cases[0].id, cases[1].id);
    assert.ok(cases.every(item => item.tags.length === 0));
    const failure = run.records.find(r => r[0] === 'failed' && r[1] === cases[1]);
    assert.equal(failure[2].message, 'Expected 1, got 2');
    assert.equal(failure[2].location.uri.toString(), 'file:///Tests.swift');
    assert.equal(failure[3], 250);
    assert.equal(run.records.filter(r => r[0] === 'skipped').length, 2);
    assert.ok(run.records.some(r => r[0] === 'appendOutput' && r[1] === 'runner output\r\nsecond line\r\n'));
    assert.ok(run.records.some(r => r[0] === 'failed' && r[1] === item && r[3] === 1500));
    s.testing.dispose();
});

test('existing Test Target commands publish native results and ignore late or unrelated events', async () => {
    const s = setup(), c = s.clients[0];
    c.execute = async originId => { start(c, originId); result(c, 'a', 'example', 1); report(c); return 1; };
    await c.test(target());
    const run = s.controller.runs[0], before = run.records.length;
    assert.equal(run.ended, 1);
    c.emit({ kind: 'log', params: { originId: 'request-1', message: 'late' } });
    c.emit({ kind: 'taskStart', params: { originId: 'compile', taskId: { id: 'compile' }, dataKind: 'test-start', data: { displayName: 'wrong' } } });
    assert.equal(run.records.length, before);
    assert.equal(s.targets()[0].children.size, 1);
    s.testing.dispose();
});

test('cancellation stops only the selected request and skips targets still in the queue', async () => {
    const c = client([target(), target('Other')]), s = setup([c]);
    c.execute = async (_origin, options) => new Promise(resolve => {
        options.token.onCancellationRequested(() => resolve(3));
    });
    const pending = s.controller.handler(request(), CancellationToken.None);
    await tick(); s.controller.runs[0].source.cancel(); await pending;
    assert.equal(c.calls.length, 1);
    assert.equal(s.controller.runs[0].ended, 1);
    assert.equal(s.controller.runs[0].records.filter(r => r[0] === 'skipped').length, 2);
    s.testing.dispose();
});

test('honors target exclusions and rejects unsupported case selection instead of running its target', async () => {
    const c = client([target(), target('Other')]), s = setup([c]);
    const [first, second] = s.targets();
    const child = s.controller.createTestItem('case', 'example'); first.children.add(child);
    await s.controller.handler(request([child]), CancellationToken.None);
    await s.controller.handler(request([first], [child]), CancellationToken.None);
    assert.equal(c.calls.length, 0);
    assert.ok(s.controller.runs.every(run => run.records.some(r => r[0] === 'errored')));
    await s.controller.handler(request(undefined, [first]), CancellationToken.None);
    assert.deepEqual(c.calls.map(call => call.target.id.uri), ['target://Other']);
    await s.controller.handler(request([second], [s.controller.items.get('server-0')]), CancellationToken.None);
    assert.equal(c.calls.length, 1);
    s.testing.dispose();
});

test('keeps concurrent servers isolated even when task and origin IDs match', () => {
    const s = setup([client(), client()]);
    for (const c of s.clients) { c.emit({ kind: 'started', target: target(), originId: 'same', cancel() {} }); start(c, 'same'); }
    result(s.clients[0], 'a', 'pass', 1); result(s.clients[1], 'a', 'fail', 2);
    for (const [index, c] of s.clients.entries()) { c.emit({ kind: 'finished', originId: 'same', status: index + 1 }); }
    assert.ok(s.controller.runs[0].records.some(r => r[0] === 'passed' && r[1].label === 'pass'));
    assert.ok(!s.controller.runs[0].records.some(r => r[0] === 'failed'));
    assert.ok(s.controller.runs[1].records.some(r => r[0] === 'failed' && r[1].label === 'fail'));
    s.testing.dispose();
});

test('reuses case identities and removes obsolete cases only after a complete report', async () => {
    const s = setup(), c = s.clients[0], item = s.targets()[0];
    c.execute = async origin => { start(c, origin); result(c, 'a', 'first', 1); result(c, 'b', 'removed', 1); report(c, { passed: 2, failed: 0, skipped: 0, ignored: 0, cancelled: 0 }); return 1; };
    await c.test(target()); const first = [...item.children.values()][0];
    c.execute = async origin => { start(c, origin); result(c, 'a', 'first', 1); report(c); return 1; };
    await c.test(target()); assert.deepEqual([...item.children.values()], [first]);
    c.execute = async origin => { start(c, origin); c.emit({ kind: 'taskStart', params: { taskId: { id: 'new', parents: ['group'] }, dataKind: 'test-start', data: { displayName: 'unfinished' } } }); return 1; };
    await c.test(target());
    const run = s.controller.runs.at(-1);
    assert.ok(run.records.some(r => r[0] === 'errored' && r[1].label === 'unfinished'));
    assert.ok(run.records.some(r => r[0] === 'errored' && r[1] === item));
    assert.equal(item.children.size, 2);
    s.testing.dispose();
});

test('disconnect closes external runs, and disposal cancels active requests once', () => {
    const s = setup(), c = s.clients[0]; let cancellations = 0;
    c.emit({ kind: 'started', target: target(), originId: 'one', cancel() { cancellations++; } });
    c.connected = false; c.emit({ kind: 'disconnected' });
    assert.equal(s.controller.runs[0].ended, 1);
    assert.ok(s.controller.runs[0].records.some(r => r[0] === 'errored' && /disconnected/.test(r[2].message)));
    assert.equal(s.targets().length, 0);
    c.connected = true; c.emit({ kind: 'connected' });
    c.emit({ kind: 'started', target: target(), originId: 'two', cancel() { cancellations++; } });
    s.testing.dispose(); s.testing.dispose();
    assert.equal(cancellations, 1);
    assert.equal(s.controller.runs[1].ended, 1);
    assert.equal(c.events.listeners.size, 0);
});

test('does not attach another target subtree or malformed status to successful test results', async () => {
    const s = setup(), c = s.clients[0], item = s.targets()[0];
    c.execute = async origin => {
        start(c, origin);
        c.emit({ kind: 'taskStart', params: { taskId: { id: 'other', parents: ['root'] }, dataKind: 'test-task', data: { target: { uri: 'target://Other' } } } });
        c.emit({ kind: 'taskStart', params: { taskId: { id: 'foreign', parents: ['other'] }, dataKind: 'test-start', data: { displayName: 'foreign' } } });
        result(c, 'a', 'invalid', 99); return 1;
    };
    await c.test(target());
    assert.deepEqual([...item.children.values()].map(i => i.label), ['invalid']);
    assert.ok(s.controller.runs[0].records.some(r => r[0] === 'errored' && r[1] === item));
    s.testing.dispose();
});

test('overlapping native requests do not replace the active run', async () => {
    const s = setup(), c = s.clients[0], item = s.targets()[0]; let release;
    c.execute = () => new Promise(resolve => { release = resolve; });
    const first = s.controller.handler(request([item]), CancellationToken.None);
    await tick();
    await s.controller.handler(request([item]), CancellationToken.None);
    assert.equal(c.calls.length, 1);
    assert.ok(s.controller.runs[1].records.some(r => r[0] === 'errored'));
    assert.equal(s.controller.runs[0].ended, 0);
    release(1); await first;
    assert.equal(s.controller.runs[0].ended, 1);
    s.testing.dispose();
});

test('disposal during a native request does not publish results after ending the run', async () => {
    const s = setup(), c = s.clients[0]; let release;
    c.execute = () => new Promise(resolve => { release = resolve; });
    const pending = s.controller.handler(request(), CancellationToken.None);
    await tick(); s.testing.dispose();
    assert.equal(s.controller.runs[0].ended, 1);
    release(3); await pending;
    assert.equal(s.controller.runs[0].ended, 1);
});

test('uses failure locations supplied only in test-finish', async () => {
    const s = setup(), c = s.clients[0];
    c.execute = async originId => {
        start(c, originId);
        c.emit({ kind: 'taskStart', params: { taskId: { id: 'a', parents: ['group'] }, dataKind: 'test-start', data: { displayName: 'example' } } });
        c.emit({ kind: 'taskFinish', params: { taskId: { id: 'a' }, status: 2, dataKind: 'test-finish', data: {
            displayName: 'example', status: 2, message: 'Failure', location: { uri: 'file:///Failed.swift', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } }
        } } });
        return 2;
    };
    await c.test(target());
    const failure = s.controller.runs[0].records.find(r => r[0] === 'failed' && r[1].label === 'example');
    assert.equal(failure[2].location.uri.toString(), 'file:///Failed.swift');
    s.testing.dispose();
});

function discoverable() {
    const change = emitter();
    const leaf = (id, line) => ({ id, label: 'Same display name', uri: vscode.Uri.parse('file:///Tests.swift'),
        range: new Range(line, 0, line + 2, 1), disabled: false, children: [], selector: { id } });
    const provider = { onDidChange: change.event, disposed: false,
        tests: [{ ...leaf('Suite', 1), selector: undefined, children: [leaf('Suite/first()', 3), leaf('Suite/second()', 8)] }],
        async discover(targets) { return new Map(targets.map(t => [t.id.uri, this.tests])); },
        selection(target, tests) { return { dataKind: 'fake-selection', data: { target: target.id, ids: tests.map(t => t.id) } }; },
        dispose() { this.disposed = true; }
    };
    const c = client(), changes = emitter(), updates = emitter();
    const connections = [{ id: 'server', client: c, connected: true, config: { name: 'Server' } }];
    const manager = { getAllConnections: () => connections, onDidChangeConnections: changes.event, onDidUpdateTargets: updates.event };
    const testing = new BspTesting(manager, undefined, [() => provider]);
    const targetItem = () => [...testing.controller.items.values()][0].children.values().next().value;
    const leaves = () => [...targetItem().children.values()][0].children;
    return { testing, provider, c, connections, changes, updates, targetItem, leaves, controller: testing.controller };
}

test('discovery supplies gutter locations and single-case results update the existing node', async () => {
    const s = discoverable(); await s.controller.refreshHandler(CancellationToken.None);
    const leaves = [...s.leaves().values()], [first, second] = leaves;
    assert.equal(first.uri.toString(), 'file:///Tests.swift'); assert.equal(first.range.start.line, 3);
    assert.equal(first.tags.length, 1); assert.notEqual(first.id, second.id);
    s.c.execute = async (origin, options) => {
        assert.deepEqual(options.selection.data.ids, ['Suite/first()']);
        start(s.c, origin); result(s.c, 'case', 'Different report name', 1, { testId: 'Suite/first()' }); report(s.c); return 1;
    };
    await s.controller.handler(request([first]), CancellationToken.None);
    const run = s.controller.runs[0];
    assert.ok(run.records.some(r => r[0] === 'passed' && r[1] === first));
    assert.ok(!run.records.some(r => r[0] === 'passed' && r[1] === second));
    assert.equal(first.range.start.line, 3); assert.equal(first.tags.length, 1);
    assert.deepEqual([...s.leaves().values()], leaves, 'Partial results must not prune the discovery tree');
    s.provider.tests[0].children[0].range = new Range(10, 0, 12, 1);
    await s.controller.refreshHandler(CancellationToken.None);
    assert.equal([...s.leaves().values()][0], first); assert.equal(first.range.start.line, 10);
    s.testing.dispose(); assert.equal(s.provider.disposed, true);
});

test('suite selection and exclusions send only the remaining runnable cases', async () => {
    const s = discoverable(); await s.controller.refreshHandler(CancellationToken.None);
    const suite = [...s.targetItem().children.values()][0], [first, second] = [...s.leaves().values()];
    await s.controller.handler(request([suite], [first]), CancellationToken.None);
    assert.deepEqual(s.c.calls[0].options.selection.data.ids, ['Suite/second()']);
    const run = s.controller.runs[0];
    assert.ok(run.records.some(r => r[0] === 'errored' && r[1] === second && /No result/.test(r[2].message)));
    assert.ok(!run.records.some(r => r[0] === 'passed' && r[1] === s.targetItem()));
    s.provider.tests[0].children[1].disabled = true;
    await s.controller.refreshHandler(CancellationToken.None);
    await s.controller.handler(request([second]), CancellationToken.None);
    assert.equal(s.c.calls.length, 1); assert.equal(second.tags.length, 0);
    s.testing.dispose();
});

test('discovery cancellation and disconnect discard stale test lists', async () => {
    const s = discoverable(); let release;
    s.provider.discover = () => new Promise(resolve => { release = resolve; });
    const refresh = s.controller.refreshHandler(CancellationToken.None); await tick();
    s.c.connected = false; s.connections[0].connected = false; s.changes.fire();
    release(new Map([[target().id.uri, s.provider.tests]])); await refresh;
    assert.equal(s.controller.items.size, 0); assert.equal(s.provider.disposed, true);
    s.testing.dispose();
});

test('selected tests with missing or unrelated results do not report success', async () => {
    const s = discoverable(); await s.controller.refreshHandler(CancellationToken.None);
    const [first] = [...s.leaves().values()];
    s.c.execute = async origin => {
        start(s.c, origin); result(s.c, 'case', 'Other', 1, { testId: 'Suite/second()' }); report(s.c); return 1;
    };
    await s.controller.handler(request([first]), CancellationToken.None);
    const run = s.controller.runs[0];
    assert.ok(run.records.some(r => r[0] === 'errored' && r[1] === first));
    assert.ok(run.records.some(r => r[0] === 'errored' && r[1] === s.targetItem()));
    s.testing.dispose();
});

test('merges suites across source files and removes deleted cases on discovery refresh', async () => {
    const s = discoverable();
    const suite = s.provider.tests[0];
    s.provider.tests = [{ ...suite, children: [suite.children[0]] }, { ...suite, children: [suite.children[1]] }];
    await s.controller.refreshHandler(CancellationToken.None);
    assert.equal(s.targetItem().children.size, 1);
    const [first, second] = [...s.leaves().values()];
    assert.equal(s.leaves().size, 2);
    s.provider.tests = [{ ...suite, children: [suite.children[0]] }];
    await s.controller.refreshHandler(CancellationToken.None);
    assert.deepEqual([...s.leaves().values()], [first]);
    await s.controller.handler(request([second]), CancellationToken.None);
    assert.equal(s.c.calls.length, 0);
    s.testing.dispose();
});


test('routes originless target tasks and keeps named results that share a task ID', async () => {
    const s = setup(), c = s.clients[0];
    c.execute = async () => {
        const taskId = { id: 'shared' };
        c.emit({ kind: 'taskStart', params: { taskId, dataKind: 'test-task', data: { target: target().id } } });
        for (const [displayName, status] of [['first', 1], ['second', 2]]) {
            c.emit({ kind: 'taskStart', params: { taskId, eventTime: 100, dataKind: 'test-start', data: { displayName } } });
            c.emit({ kind: 'taskFinish', params: { taskId, eventTime: 120, status: 1, dataKind: 'test-finish', data: { displayName, status, message: 'assertion failed' } } });
        }
        c.emit({ kind: 'taskFinish', params: { taskId, status: 2, dataKind: 'test-report', data: {
            target: target().id, passed: 1, failed: 1, ignored: 0, cancelled: 0, skipped: 0
        } } });
        return 2;
    };
    await c.test(target());
    const item = s.targets()[0], run = s.controller.runs[0];
    assert.deepEqual([...item.children.values()].map(item => item.label), ['first', 'second']);
    assert.ok(run.records.some(([method, item]) => method === 'passed' && item.label === 'first'));
    assert.ok(run.records.some(([method, item]) => method === 'failed' && item.label === 'second'));
    assert.ok(run.records.some(([method, result]) => method === 'failed' && result === item));
    s.testing.dispose();
});

test('target fallback cannot override an explicit unrelated origin or another connection', async () => {
    const s = setup([client(), client()]), [a, b] = s.clients;
    a.execute = async originId => {
        const params = { taskId: { id: 'unrelated' }, dataKind: 'test-task', data: { target: target().id } };
        a.emit({ kind: 'taskStart', params: { ...params, originId: 'unknown' } });
        b.emit({ kind: 'taskStart', params });
        for (const c of [a, b]) {
            c.emit({ kind: 'taskFinish', params: { taskId: params.taskId, dataKind: 'test-finish', data: { displayName: 'wrong', status: 2 } } });
        }
        start(a, originId); result(a, 'good', 'correct', 1); report(a);
        return 1;
    };
    await a.test(target());
    assert.deepEqual([...s.targets()[0].children.values()].map(item => item.label), ['correct']);
    assert.equal(s.targets()[1].children.size, 0);
    s.testing.dispose();
});
