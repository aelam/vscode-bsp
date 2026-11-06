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
    await fs.writeFile(configPath, JSON.stringify({ languages: ['swift'] }));
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
    assert.deepEqual(notifications, ['open', 'change']);
    files = [];
    assert.deepEqual((await adapter.discover([tests], CancellationToken.None)).get(tests.id.uri), []);
    await closed;
    assert.ok(notifications.includes('close'));
    assert.throws(() => adapter.selection(tests, [{ ...updated[0], disabled: true }]), /individual selection/);
});
