const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationToken } = require('vscode-jsonrpc/node');
const disposable = () => ({ dispose() {} });
const workspace = {
    textDocuments: [],
    onDidChangeTextDocument: disposable, onDidCloseTextDocument: disposable,
    onDidCreateFiles: disposable, onDidDeleteFiles: disposable, onDidRenameFiles: disposable,
    createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable })
};
const vscode = {
    workspace,
    EventEmitter: class { event = disposable; fire() {} dispose() {} },
    RelativePattern: class {},
    Uri: { parse: value => ({ toString: () => value }) },
    Range: class { constructor(line, character, endLine, endCharacter) {
        this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
    } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } }
};
let startServer;
const originalLoad = Module._load;
Module._load = function(name, ...args) {
    if (name === 'vscode') { return vscode; }
    if (name === 'child_process') { return { spawn: (...args) => startServer(...args) }; }
    return originalLoad.call(this, name, ...args);
};
let convert, sourcekitTestDiscovery;
try { ({ convert, sourcekitTestDiscovery } = require('../out/sourcekitTestDiscovery')); }
finally { Module._load = originalLoad; }

function testCase(id, uri = 'file:///Tests/DemoTests.swift', line = 4, children = []) {
    return { id, label: id, style: 'swift-testing', children,
        location: { uri, range: { start: { line, character: 0 }, end: { line: line + 2, character: 1 } } } };
}
function target(uri = 'target://DemoTests', moduleName = 'DemoTests') {
    return { id: { uri }, capabilities: { canTest: true }, dataKind: 'sourceKit', data: {
        toolchain: 'file:///opt/swift/',
        testDiscovery: { provider: 'sourcekit-lsp', version: 1, selectionDataKind: 'sourcekit-test-selection', moduleName }
    } };
}

test('known modules preserve fallback IDs, dots, locations, and nested XCTest selectors', () => {
    for (const id of ['namedGreeting()', 'Suite/test.version()', 'Other.testName()']) {
        const actual = convert(testCase(id), 'DemoTests');
        assert.equal(actual.id, id);
        assert.deepEqual(actual.selector, { id, style: 'swift-testing' });
        assert.equal(actual.uri.toString(), 'file:///Tests/DemoTests.swift');
        assert.deepEqual(actual.range.start, { line: 4, character: 0 });
    }
    const value = testCase('DemoTests.LegacyGreetingTests', undefined, 17,
        [{ ...testCase('DemoTests.LegacyGreetingTests/testNamedGreeting()', undefined, 18), style: 'XCTest' }]);
    const actual = convert(value, 'DemoTests');
    assert.equal(actual.id, 'LegacyGreetingTests');
    assert.equal(actual.selector, undefined);
    assert.deepEqual(actual.children[0].selector, { id: 'LegacyGreetingTests/testNamedGreeting()', style: 'XCTest' });
    assert.equal(convert(testCase('DemoTests.oldXcodeCase()')).id, 'oldXcodeCase()');
    assert.equal(convert({ ...testCase('bad()'), location: undefined }, 'DemoTests'), undefined);
    assert.equal(convert({ ...testCase('unsupported()'), style: 'other' }, 'DemoTests').selector, undefined);
});

test('SwiftPM discovery opens source files, keeps case locations, and sends exact selection data', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-discovery-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '.bsp'));
    const configPath = path.join(root, '.bsp/sourcekit-bsp.json');
    await fs.writeFile(configPath, JSON.stringify({ name: 'SourceKit', version: '0.2', bspVersion: '2.2.0',
        languages: ['swift'], argv: ['sourcekit-bsp'] }));
    const file = path.join(root, 'DemoTests.swift');
    const uri = pathToFileURL(file).href;
    await fs.writeFile(file, '@Test func namedGreeting() {}');
    const notifications = [];
    let closeDocument;
    const closed = new Promise(resolve => { closeDocument = resolve; });
    let text = '', requestLine = 4, child;
    startServer = (executable, _args, options) => {
        assert.equal(executable, '/opt/swift/usr/bin/sourcekit-lsp');
        assert.equal(options.cwd, root);
        assert.equal(options.env.DEVELOPER_DIR, process.env.DEVELOPER_DIR);
        child = new EventEmitter();
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
        const rpc = createMessageConnection(new StreamMessageReader(child.stdin), new StreamMessageWriter(child.stdout));
        rpc.onRequest('initialize', () => ({ capabilities: { experimental: { 'textDocument/tests': { version: 2 } } } }));
        rpc.onNotification('textDocument/didOpen', params => { notifications.push('open'); text = params.textDocument.text; });
        rpc.onNotification('textDocument/didChange', params => { notifications.push('change'); text = params.contentChanges[0].text; });
        rpc.onNotification('textDocument/didClose', () => { notifications.push('close'); closeDocument(); });
        rpc.onRequest('textDocument/tests', params => {
            assert.equal(params.textDocument.uri, uri);
            return [testCase(text.includes('changed') ? 'DemoTests.changed()' : 'namedGreeting()', uri, requestLine)];
        });
        rpc.listen();
        child.kill = () => { child.exitCode = 0; rpc.dispose(); child.emit('exit', 0); return true; };
        return child;
    };
    const tests = target();
    let files = [{ uri, kind: 1 }];
    const connection = { config: { configPath, name: 'Demo', workspaceUri: { fsPath: root, toString: () => pathToFileURL(root).href } },
        client: { targets: [tests], getSources: async () => [{ target: tests.id, sources: files }] } };
    const adapter = sourcekitTestDiscovery(connection);
    assert.ok(adapter);
    t.after(() => { adapter.dispose(); workspace.textDocuments = []; });
    const discovered = (await adapter.discover([tests], CancellationToken.None)).get(tests.id.uri);
    assert.equal(discovered[0].uri.toString(), uri);
    assert.deepEqual(discovered[0].range.start, { line: 4, character: 0 });
    assert.deepEqual(adapter.selection(tests, discovered), { dataKind: 'sourcekit-test-selection', data: {
        tests: [{ target: tests.id, id: 'namedGreeting()', style: 'swift-testing' }]
    } });
    workspace.textDocuments = [{ uri: vscode.Uri.parse(uri), getText: () => '@Test func changed() {}' }];
    requestLine = 8;
    const updated = (await adapter.discover([tests], CancellationToken.None)).get(tests.id.uri);
    assert.equal(updated[0].id, 'changed()');
    assert.deepEqual(updated[0].range.start, { line: 8, character: 0 });
    await until(() => notifications.filter(kind => kind === 'close').length === 2);
    assert.deepEqual(notifications, ['open', 'close', 'open', 'close']);
    files = [];
    assert.deepEqual((await adapter.discover([tests], CancellationToken.None)).get(tests.id.uri), []);
    await closed;
    assert.ok(notifications.includes('close'));
    assert.throws(() => adapter.selection(tests, [{ ...updated[0], disabled: true }]), /individual selection/);
});

async function until(condition) {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(condition(), 'The expected protocol event did not arrive');
}

async function discoveryFixture(t, count, handle, initialize) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-bounded-discovery-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '.bsp'));
    const configPath = path.join(root, '.bsp/sourcekit-bsp.json');
    await fs.writeFile(configPath, JSON.stringify({ name: 'SourceKit', version: '0.2', bspVersion: '2.2.0',
        languages: ['swift'], argv: ['sourcekit-bsp'] }));
    const files = [];
    for (let index = 0; index < count; index++) {
        const file = path.join(root, `Tests${index}.swift`);
        await fs.writeFile(file, `@Test func test${index}() {}`);
        files.push({ uri: pathToFileURL(file).href, kind: 1 });
    }
    const events = [], sent = [], opened = new Set();
    let starts = 0, maximum = 0, child;
    startServer = () => {
        starts++;
        child = new EventEmitter();
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
        let buffered = Buffer.alloc(0);
        child.stdin.on('data', chunk => {
            buffered = Buffer.concat([buffered, chunk]);
            while (true) {
                const separator = buffered.indexOf('\r\n\r\n');
                if (separator < 0) { break; }
                const length = Number(/Content-Length: (\d+)/i.exec(buffered.subarray(0, separator).toString())[1]);
                if (buffered.length < separator + 4 + length) { break; }
                const message = JSON.parse(buffered.subarray(separator + 4, separator + 4 + length).toString());
                if (message.method) { sent.push(message.method); }
                buffered = buffered.subarray(separator + 4 + length);
            }
        });
        const rpc = createMessageConnection(new StreamMessageReader(child.stdin), new StreamMessageWriter(child.stdout));
        rpc.onRequest('initialize', () => {
            initialize?.();
            return { capabilities: { experimental: { 'textDocument/tests': { version: 2 } } } };
        });
        rpc.onNotification('textDocument/didOpen', params => {
            assert.ok(!opened.has(params.textDocument.uri));
            opened.add(params.textDocument.uri); maximum = Math.max(maximum, opened.size);
            events.push(['open', params.textDocument.uri, params.textDocument.version]);
        });
        rpc.onNotification('textDocument/didClose', params => {
            opened.delete(params.textDocument.uri); events.push(['close', params.textDocument.uri]);
        });
        rpc.onRequest('textDocument/tests', async params => {
            assert.ok(opened.has(params.textDocument.uri));
            events.push(['tests', params.textDocument.uri]);
            if (handle) { return await handle(params.textDocument.uri, child); }
            return [testCase('DemoTests.example()', params.textDocument.uri)];
        });
        rpc.listen();
        child.kill = () => { sent.push('process/kill'); opened.clear(); child.exitCode = 0; rpc.dispose(); child.emit('exit', 0); return true; };
        return child;
    };
    const tests = target();
    const connection = { config: { configPath, name: 'Demo', workspaceUri: { fsPath: root, toString: () => pathToFileURL(root).href } },
        client: { targets: [tests], getSources: async () => [{ target: tests.id, sources: files }] } };
    const adapter = sourcekitTestDiscovery(connection);
    t.after(() => { adapter.dispose(); workspace.textDocuments = []; });
    return { adapter, tests, files, events, sent, opened, get maximum() { return maximum; }, get starts() { return starts; },
        flush: () => until(() => opened.size === 0) };
}

test('large discovery interleaves each open and test request with a close before opening the next file', async t => {
    const fixture = await discoveryFixture(t, 50);
    const result = await fixture.adapter.discover([fixture.tests], CancellationToken.None);
    await fixture.flush();
    assert.equal(result.get(fixture.tests.id.uri).length, 50);
    assert.equal(fixture.maximum, 1);
    assert.equal(fixture.opened.size, 0);
    assert.deepEqual(fixture.events.map(event => event[0]), Array.from({ length: 50 }, () => ['open', 'tests', 'close']).flat());
    await fixture.adapter.discover([fixture.tests], CancellationToken.None);
    await fixture.flush();
    assert.equal(fixture.starts, 1, 'The existing LSP process must serve the next discovery');
    assert.equal(fixture.opened.size, 0);
    assert.ok(fixture.events.slice(150).filter(event => event[0] === 'open').every(event => event[2] === 2));
});

test('a failed document request closes its document and preserves the session for a later retry', async t => {
    let fail = true;
    const fixture = await discoveryFixture(t, 3, uri => {
        if (fail && uri.endsWith('/Tests1.swift')) { throw new Error('Broken test discovery'); }
        return [testCase('DemoTests.example()', uri)];
    });
    await assert.rejects(fixture.adapter.discover([fixture.tests], CancellationToken.None), /Tests1\.swift.*Broken test discovery/);
    await fixture.flush();
    assert.equal(fixture.opened.size, 0);
    assert.deepEqual(fixture.events.map(event => event[0]), ['open', 'tests', 'close', 'open', 'tests', 'close']);
    fail = false;
    const result = await fixture.adapter.discover([fixture.tests], CancellationToken.None);
    await fixture.flush();
    assert.equal(result.get(fixture.tests.id.uri).length, 3);
    assert.equal(fixture.starts, 1);
    assert.equal(fixture.maximum, 1);
});

test('cancellation closes the active document and does not open the remaining sources', async t => {
    const { CancellationTokenSource } = require('vscode-jsonrpc/node');
    const cancellation = new CancellationTokenSource();
    t.after(() => cancellation.dispose());
    const fixture = await discoveryFixture(t, 3, () => { cancellation.cancel(); return []; });
    await assert.rejects(fixture.adapter.discover([fixture.tests], cancellation.token), /cancelled/);
    await fixture.flush();
    assert.deepEqual(fixture.events.map(event => event[0]), ['open', 'tests', 'close']);
    assert.equal(fixture.opened.size, 0);
    await fixture.adapter.discover([fixture.tests], CancellationToken.None);
    await fixture.flush();
    assert.equal(fixture.starts, 1);
});

test('document timeouts close and stop the session before the next explicit discovery creates a new one', async t => {
    const originalTimeout = global.setTimeout;
    let timeout;
    global.setTimeout = (callback, delay, ...args) => {
        if (delay === 30000) { timeout = () => callback(...args); }
        return originalTimeout(callback, delay, ...args);
    };
    t.after(() => { global.setTimeout = originalTimeout; });
    let fail = true;
    const fixture = await discoveryFixture(t, 2, async (uri, child) => {
        if (!fail) { return [testCase('DemoTests.example()', uri)]; }
        child.stderr.write('discard-this-prefix:' + 'x'.repeat(9000) + '\ncompiler-work-queued');
        await new Promise(resolve => setImmediate(resolve));
        timeout();
        return [];
    });
    const error = await fixture.adapter.discover([fixture.tests], CancellationToken.None).then(
        () => assert.fail('The document request should time out'), error => error);
    assert.match(error.message, /timed out: textDocument\/tests.*Tests0\.swift/);
    assert.match(error.message, /compiler-work-queued/);
    assert.doesNotMatch(error.message, /discard-this-prefix/);
    assert.ok(error.message.length < 9000);
    await fixture.flush();
    assert.deepEqual(fixture.events.filter(event => event[0] !== 'close').map(event => event[0]), ['open', 'tests']);
    assert.deepEqual(fixture.sent.slice(-2), ['textDocument/didClose', 'process/kill']);
    assert.equal(fixture.opened.size, 0);
    assert.equal(fixture.starts, 1, 'A timeout must not retry automatically');
    fail = false;
    const result = await fixture.adapter.discover([fixture.tests], CancellationToken.None);
    await fixture.flush();
    assert.equal(fixture.starts, 2);
    assert.equal(result.get(fixture.tests.id.uri).length, 2);
    assert.equal(fixture.maximum, 1);
});

test('an initialize timeout stops the incomplete session and a later discovery initializes again', async t => {
    const originalTimeout = global.setTimeout;
    let timeout, fail = true;
    global.setTimeout = (callback, delay, ...args) => {
        if (delay === 30000) { timeout = () => callback(...args); }
        return originalTimeout(callback, delay, ...args);
    };
    t.after(() => { global.setTimeout = originalTimeout; });
    const fixture = await discoveryFixture(t, 1, undefined, () => { if (fail) { timeout(); } });
    await assert.rejects(fixture.adapter.discover([fixture.tests], CancellationToken.None), /timed out: initialize/);
    assert.equal(fixture.starts, 1);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.sent.at(-1), 'process/kill');
    fail = false;
    const result = await fixture.adapter.discover([fixture.tests], CancellationToken.None);
    await fixture.flush();
    assert.equal(fixture.starts, 2);
    assert.equal(result.get(fixture.tests.id.uri).length, 1);
});
