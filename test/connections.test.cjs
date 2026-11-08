const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');

class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
}
const uri = fsPath => ({ fsPath, toString: () => `file://${fsPath}` });
const directories = new Map();
const vscode = {
    EventEmitter,
    FileType: { File: 1 },
    Uri: { joinPath: (root, ...parts) => uri(path.join(root.fsPath, ...parts)) },
    workspace: {
        getWorkspaceFolder: root => ({ name: path.basename(root.fsPath) }),
        fs: {
            async readDirectory(root) {
                if (!directories.has(root.fsPath)) { throw Object.assign(new Error('Missing directory'), { code: 'FileNotFound' }); }
                return directories.get(root.fsPath).map(name => [name, 1]);
            },
            async readFile() { return Buffer.from(JSON.stringify({ name: 'BSP' })); }
        }
    }
};
class BspClient {
    constructor(workspaceUri, configPath, onTargetsUpdated, preferences) {
        Object.assign(this, { workspaceUri, configPath, onTargetsUpdated, preferences });
    }
    operations = { onDidChange: () => ({ dispose() {} }) };
    backgroundTasks = { onDidChange: () => ({ dispose() {} }) };
    async connect() { this.connectCount = (this.connectCount ?? 0) + 1; }
    async disconnect() { this.disconnectCount = (this.disconnectCount ?? 0) + 1; }
}
const originalLoad = Module._load;
Module._load = function(name, ...args) {
    if (name === 'vscode') { return vscode; }
    if (name === './bspClient') { return { BspClient }; }
    return originalLoad.call(this, name, ...args);
};
let BspConnectionManager;
try { ({ BspConnectionManager } = require('../out/bspConnectionManager')); }
finally { Module._load = originalLoad; }

test('finds BSP configurations in all roots even when the first root has none', async () => {
    directories.clear();
    directories.set('/swift/.bsp', ['sourcekit.json']);
    directories.set('/kotlin/.bsp', ['mill.json', 'README.md']);
    const preferences = { get: () => undefined, update: async () => {} };
    const manager = new BspConnectionManager(preferences);
    const configs = await manager.discoverWorkspaceConfigurations([uri('/docs'), uri('/swift'), uri('/kotlin')]);
    assert.deepEqual(configs.map(config => config.configPath), ['/swift/.bsp/sourcekit.json', '/kotlin/.bsp/mill.json']);
    for (const config of configs) { await manager.addConnection(config); }
    const [swift, kotlin] = manager.getAllConnections();
    assert.equal(swift.client.preferences, preferences);
    assert.equal(kotlin.client.preferences, preferences);
    assert.equal(swift.client.workspaceUri.fsPath, '/swift');
    assert.equal(kotlin.client.workspaceUri.fsPath, '/kotlin');
    assert.equal(kotlin.client.configPath, '/kotlin/.bsp/mill.json');
    assert.equal(swift.config.displayName, 'BSP (swift)');
    assert.equal(kotlin.config.displayName, 'BSP (kotlin)');
    await manager.connectAll();
    await manager.removeConnection(swift.id);
    assert.equal(swift.client.disconnectCount, 1);
    assert.equal(kotlin.client.disconnectCount, undefined);
    assert.equal(manager.getConnectedClients()[0].connectionId, kotlin.id);
});

test('rediscovery preserves the connection, client, and active state without duplicates', async () => {
    const manager = new BspConnectionManager();
    const config = { name: 'Mill', workspaceUri: uri('/kotlin'), configPath: '/kotlin/.bsp/mill.json' };
    const id = await manager.addConnection(config);
    await manager.connectToServer(id);
    const original = manager.getConnection(id);
    const repeated = await Promise.all([manager.addConnection({ ...config }), manager.addConnection({ ...config })]);
    assert.deepEqual(repeated, [id, id]);
    assert.equal(manager.getAllConnections().length, 1);
    assert.equal(manager.getConnection(id), original);
    assert.equal(original.connected, true);
    assert.equal(original.client.connectCount, 1);
    assert.notEqual(await manager.addConnection({ ...config, configPath: '/kotlin/.bsp/other.json' }), id);
});


test('loads two BSP configurations from one folder and isolates their clients', async () => {
    directories.clear();
    directories.set('/polyglot/.bsp', ['sourcekit-bsp.json', 'mill-bsp.json']);
    const manager = new BspConnectionManager();
    const configs = await manager.discoverBspConfigurations(uri('/polyglot'));
    for (const config of configs) { await manager.addConnection(config); }
    await manager.connectAll();
    const [swift, kotlin] = manager.getAllConnections();
    assert.equal(manager.getConnectedClients().length, 2);
    assert.notEqual(swift.client, kotlin.client);
    assert.notEqual(swift.client.configPath, kotlin.client.configPath);
    assert.equal(swift.client.workspaceUri.fsPath, kotlin.client.workspaceUri.fsPath);
    for (const config of await manager.discoverBspConfigurations(uri('/polyglot'))) { await manager.addConnection(config); }
    assert.equal(manager.getAllConnections().length, 2);
    await manager.disconnectFromServer(swift.id);
    assert.equal(kotlin.connected, true);
    assert.equal(kotlin.client.disconnectCount, undefined);
});
