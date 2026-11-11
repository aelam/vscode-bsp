const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const Module = require('node:module');

const picks = [], reveals = [], notices = [], stats = [];
let select = items => items[0];
const parse = value => {
    const url = new URL(value);
    return {
        scheme: url.protocol.slice(0, -1), path: decodeURIComponent(url.pathname),
        fsPath: url.protocol === 'file:' ? fileURLToPath(url) : decodeURIComponent(url.pathname),
        toString: () => url.href
    };
};
const file = value => parse(pathToFileURL(value).href);
const vscode = {
    Uri: { parse, file }, FileType: { File: 1, Directory: 2 },
    workspace: { fs: { stat: async uri => {
        stats.push(uri.fsPath);
        try {
            const value = await fs.stat(uri.fsPath);
            return { type: value.isDirectory() ? 2 : 1 };
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { error.code = 'FileNotFound'; }
            throw error;
        }
    } } },
    commands: { executeCommand: async (command, uri) => {
        assert.equal(command, 'revealInExplorer'); reveals.push(uri.fsPath);
    } },
    window: {
        showQuickPick: async (items, options) => { picks.push({ items, options }); return select(items); },
        showInformationMessage: message => notices.push(message)
    }
};
const load = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
let navigateToTargetFolder;
try { ({ navigateToTargetFolder } = require('../out/targetFolders')); } finally { Module._load = load; }

beforeEach(() => {
    for (const list of [picks, reveals, notices, stats]) { list.length = 0; }
    select = items => items[0];
});

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-folders-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = path.join(root, 'Example.xcodeproj');
    await fs.mkdir(project);
    const target = {
        id: { uri: file(project).toString().replace('file:', 'xcode:') + '/App' },
        displayName: 'App', baseDirectory: file(root).toString()
    };
    const directory = async name => {
        const result = path.join(root, name);
        await fs.mkdir(result, { recursive: true });
        return result;
    };
    return { root, project, target, directory };
}

const source = (value, kind = 1, generated = false) => ({ uri: file(value).toString(), kind, generated });
const client = (target, sources, roots) => ({ connected: true, getSources: async targets => {
    assert.deepEqual(targets.map(value => value.id), [target.id]);
    return [{ target: target.id, sources, roots }];
} });

test('Xcode navigation lists distinct target source folders before the project locations', async t => {
    const f = await fixture(t);
    const app = await f.directory('App'), views = await f.directory('App/Views'), shared = await f.directory('Shared');
    const c = client(f.target, [source(path.join(app, 'App.swift')), source(path.join(app, 'Model.swift')),
        source(path.join(views, 'View.swift')), source(path.join(shared, 'Utility.swift'))]);
    const getSources = c.getSources;
    c.getSources = async targets => [...await getSources(targets), {
        target: { uri: 'target://other' }, sources: [source(f.project, 2)]
    }];
    select = items => items.find(item => item.uri.fsPath === shared);
    await navigateToTargetFolder({ buildTarget: f.target }, c);
    assert.deepEqual(picks[0].items.map(item => item.uri.fsPath), [app, views, shared, f.root, f.project]);
    assert.deepEqual(picks[0].items.slice(0, 3).map(item => item.detail), Array(3).fill('Source folder'));
    assert.equal(stats.filter(value => value === app).length, 1);
    assert.equal(picks[0].options.matchOnDescription, true);
    assert.match(picks[0].options.title, /App/);
    assert.deepEqual(reveals, [shared]);
});

test('source roots and directory entries are deduplicated and generated folders follow source folders', async t => {
    const f = await fixture(t);
    const root = await f.directory('Sources'), app = await f.directory('Sources/应用 100%20'), generated = await f.directory('Generated');
    const c = client(f.target, [source(root + path.sep, 2), source(app, 2),
        ...Array.from({ length: 100 }, (_, index) => source(path.join(app, `${index}.swift`))),
        source(path.join(generated, 'Derived.swift'), 1, true),
        source(path.join(f.root, 'Missing/Derived.swift'), 1, true)
    ], [file(root).toString()]);
    await navigateToTargetFolder({ buildTarget: f.target }, c);
    assert.deepEqual(picks[0].items.map(item => item.uri.fsPath), [root, app, generated, f.root, f.project]);
    assert.equal(picks[0].items[0].detail, 'Source root');
    assert.equal(picks[0].items[2].detail, 'Generated sources');
    assert.equal(stats.filter(value => value === app).length, 1);
    assert.equal(stats.filter(value => value === root).length, 1);
});

test('dependency navigation requests the dependency target and reveals a single source folder directly', async t => {
    const f = await fixture(t), folder = await f.directory('Dependency');
    const dependency = { uri: 'target://dependency' };
    await navigateToTargetFolder({ dependency }, client({ id: dependency }, [source(folder, 2)]));
    assert.deepEqual(reveals, [folder]);
    assert.equal(picks.length, 0);
});

test('unsupported source requests keep existing project navigation available', async t => {
    const f = await fixture(t);
    await navigateToTargetFolder({ buildTarget: f.target }, {
        connected: true, getSources: async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); }
    });
    assert.deepEqual(picks[0].items.map(item => item.uri.fsPath), [f.root, f.project]);
    assert.deepEqual(reveals, [f.root]);
});

test('disconnected clients use the base directory without requesting sources', async t => {
    const f = await fixture(t);
    const target = { id: { uri: 'target://app' }, baseDirectory: file(f.root).toString() };
    await navigateToTargetFolder({ buildTarget: target }, { connected: false, getSources: () => assert.fail() });
    assert.deepEqual(reveals, [f.root]);
});

test('remote source URIs and missing source folders do not become unrelated local folders', async t => {
    const f = await fixture(t), folder = await f.directory('Remote');
    const target = { id: { uri: 'target://app' } };
    await navigateToTargetFolder({ buildTarget: target }, client(target, [
        { uri: 'https://server' + folder, kind: 2, generated: false },
        source(path.join(f.root, 'Missing/File.swift'))
    ]));
    assert.equal(reveals.length, 0);
    assert.equal(picks.length, 0);
    assert.match(notices[0], /No existing source or project directory/);
});

test('cancelling the folder picker does not reveal a folder', async t => {
    const f = await fixture(t);
    select = () => undefined;
    await navigateToTargetFolder({ buildTarget: f.target }, client(f.target, []));
    assert.equal(picks.length, 1);
    assert.equal(reveals.length, 0);
});
