const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const Module = require('node:module');
const { CancellationToken } = require('vscode-jsonrpc/node');

const root = __dirname;
const failureMarker = path.join(root, 'p2/tests/resources/fail-test.txt');
const expectFailure = process.argv.includes('--expect-failure');
const notifications = [];
const records = [];
const noop = () => {};
const subscription = () => ({ dispose: noop });
const uri = value => ({ fsPath: fileURLToPath(value), toString: () => value });
class EventEmitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
    dispose() { this.listeners.clear(); }
}
class Collection extends Map {
    constructor(parent) { super(); this.parent = parent; }
    add(item) { item.parent = this.parent; this.set(item.id, item); }
    replace(items) { this.clear(); items.forEach(item => this.add(item)); }
}
const controller = {
    items: new Collection(),
    createTestItem(id, label, uri) { const item = { id, label, uri }; item.children = new Collection(item); return item; },
    createRunProfile: noop,
    createTestRun() {
        const run = { token: CancellationToken.None, end: noop };
        for (const method of ['enqueued', 'started', 'passed', 'failed', 'errored', 'skipped', 'appendOutput']) {
            run[method] = (...args) => records.push([method, ...args]);
        }
        return run;
    },
    dispose: noop
};
const vscode = {
    EventEmitter,
    FileType: { File: 1, Directory: 2 },
    Uri: {
        file: value => uri(pathToFileURL(value).href), parse: uri,
        joinPath: (root, ...parts) => uri(pathToFileURL(path.join(root.fsPath, ...parts)).href)
    },
    Range: class { constructor(line, character, endLine, endCharacter) {
        this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
    } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    RelativePattern: class {},
    workspace: {
        fs: {
            readFile: value => fs.readFile(value.fsPath),
            async readDirectory(value) {
                return (await fs.readdir(value.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isFile() ? 1 : 2]);
            }
        },
        getWorkspaceFolder: () => ({ name: 'Hello' }),
        textDocuments: [],
        onDidChangeTextDocument: subscription, onDidCloseTextDocument: subscription,
        onDidCreateFiles: subscription, onDidDeleteFiles: subscription, onDidRenameFiles: subscription,
        createFileSystemWatcher: () => ({ dispose: noop, onDidChange: subscription, onDidCreate: subscription, onDidDelete: subscription })
    },
    tests: { createTestController: () => controller },
    TestTag: class { constructor(id) { this.id = id; } },
    TestMessage: class { constructor(message) { this.message = message; } },
    TestRunRequest: class { constructor(include) { this.include = include; } },
    TestRunProfileKind: { Run: 1 },
    languages: { createDiagnosticCollection: () => ({ clear: noop, set: noop }) },
    debug: { onDidStartDebugSession: subscription, onDidTerminateDebugSession: subscription },
    window: {
        withProgress: (_options, action) => action({ report: noop }, CancellationToken.None),
        setStatusBarMessage: noop,
        showInformationMessage: noop,
        showWarningMessage: console.warn,
        showErrorMessage: console.error
    },
    ProgressLocation: { Notification: 15 }
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
let BspConnectionManager, BspTesting, sourcekitTestDiscovery;
try {
    ({ BspConnectionManager } = require('../../out/bspConnectionManager'));
    ({ sourcekitTestDiscovery } = require('../../out/sourcekitTestDiscovery'));
    ({ BspTesting } = require('../../out/bspTesting'));
} finally { Module._load = originalLoad; }

async function main() {
    const markerExists = await fs.access(failureMarker).then(() => true, () => false);
    assert.equal(markerExists, expectFailure, 'The failure marker must match --expect-failure');
    const manager = new BspConnectionManager();
    let testing, discovery;
    const timeout = setTimeout(() => {
        console.error('BSP smoke test timed out');
        for (const connection of manager.getAllConnections()) { connection.client.serverProcess?.kill(); }
        process.exit(1);
    }, 180000);
    try {
        const directory = path.join(root, '.bsp-smoke');
        await fs.mkdir(directory, { recursive: true });
        const configs = await manager.discoverBspConfigurations(vscode.Uri.file(root));
        assert.equal(configs.length, 2, 'Expected two BSP configurations in the same folder');
        for (const config of configs) { await manager.addConnection(config); }
        for (const connection of manager.getAllConnections()) {
            connection.client.onTestEvent(event => notifications.push({ connection: connection.config.name, ...event }));
        }
        await manager.connectAll();
        assert.equal(manager.getConnectedClients().length, 2, 'Both servers must connect');
        await Promise.all(manager.getConnectedClients().map(({ client }) => client.getBuildTargets()));
        const mill = manager.getAllConnections().find(connection => connection.config.name === 'mill-bsp');
        const swift = manager.getAllConnections().find(connection => connection.config.name === 'sourcekit-bsp');
        assert.ok(mill && swift, 'Expected Mill and SourceKit connections');
        assert.equal(mill.config.workspaceUri.toString(), swift.config.workspaceUri.toString());
        const client = mill.client;
        const targets = client.targets;
        const swiftTargets = swift.client.targets;
        assert.ok(swiftTargets.some(target => target.displayName === 'Hello'));
        assert.ok(swiftTargets.some(target => target.displayName === 'HelloTests'));
        assert.ok(swiftTargets.some(target => target.displayName === 'HelloUITests'));
        assert.ok(swiftTargets.every(target => target.id.uri.includes('/p1/Hello.xcodeproj/')));
        const kotlinRoot = pathToFileURL(path.join(root, 'p2')).href;
        assert.ok(targets.every(target => target.id.uri === kotlinRoot || target.id.uri.startsWith(kotlinRoot + '/')));
        console.log('Two BSP servers connected to the same root:', root);
        discovery = sourcekitTestDiscovery(swift);
        assert.ok(discovery, 'The SourceKit server must advertise test discovery');
        const swiftTests = await discovery.discover(swiftTargets.filter(target => target.capabilities.canTest), CancellationToken.None);
        const leaves = tests => tests.flatMap(test => test.children.length ? leaves(test.children) : [test]);
        const discovered = [...swiftTests.values()].flatMap(leaves);
        assert.equal(discovered.length, 4, 'Expected three Swift unit tests and one UI test');
        for (const test of discovered) {
            assert.ok(test.uri.fsPath.startsWith(path.join(root, 'p1') + path.sep));
            await fs.access(test.uri.fsPath);
        }
        console.log('Swift test discovery with both BSP configurations:', discovered.map(test => test.label).join(', '));
        discovery.dispose(); discovery = undefined;
        const app = targets.find(target => target.displayName === 'app');
        const tests = targets.find(target => target.capabilities.canTest);
        assert.ok(app?.capabilities.canCompile && app.capabilities.canRun, 'Missing app target');
        assert.ok(tests?.capabilities.canTest, 'Missing test target');
        assert.ok(tests.dependencies.some(dependency => dependency.uri === app.id.uri), 'Missing app dependency');
        console.log('Targets:', targets.map(target => `${target.displayName} (${target.languageIds.join(', ')})`).join('; '));
        assert.equal((await client.compile(app)).statusCode, 1);
        testing = new BspTesting(manager);
        assert.equal(controller.items.size, 2, 'Tests must be grouped by server');
        const result = await client.test(tests);
        await fs.writeFile(path.join(directory, expectFailure ? 'failure.json' : 'pass.json'), JSON.stringify(notifications, null, 2));
        assert.equal(result.statusCode, expectFailure ? 2 : 1);
        const target = controller.items.get(mill.id).children.values().next().value;
        assert.ok(target.children.size >= 4, `Expected at least four test cases; found ${target.children.size}`);
        assert.ok(records.some(([method, item]) => method === (expectFailure ? 'failed' : 'passed') && item === target));
        assert.equal(records.filter(([method]) => method === 'errored').length, 0);
        if (expectFailure) {
            assert.ok(records.some(([method, item, message]) => method === 'failed' && item !== target && message.message.includes('Intentional BSP test failure')));
        }
        assert.equal((await client.run(app)).statusCode, 1);
        assert.equal(controller.items.get(swift.id).children.size, 2);
        await manager.disconnectFromServer(swift.id);
        assert.ok((await client.getBuildTargets()).some(target => target.displayName === 'app'));
        console.log(`BSP compile/run/test verified: ${target.children.size} test results, expected ${expectFailure ? 'failure' : 'success'}.`);
    } finally {
        discovery?.dispose();
        testing?.dispose();
        await manager.disconnectAll();
        for (const connection of manager.getAllConnections()) { connection.client.serverProcess?.kill(); }
        clearTimeout(timeout);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
