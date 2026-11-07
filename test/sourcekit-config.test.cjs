const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateSourcekitBspConfig } = require('../out/sourcekitBspConfig');

const configuration = (languages = ['swift', 'c']) => ({
    name: 'SourceKit', version: '0.2', bspVersion: '2.2.0', languages,
    argv: ['sourcekit-bsp', '--package', 'p3'], kind: 'swiftpm'
});
async function workspace(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-config-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, '.bsp');
    await fs.mkdir(directory);
    return { root, directory, async write(name, config = configuration()) {
        const file = path.join(directory, name);
        await fs.writeFile(file, JSON.stringify(config));
        return file;
    } };
}

test('Swift discovery accepts a Kotlin BSP beside the selected Swift connection', async t => {
    const { root, write } = await workspace(t);
    const swift = await write('sourcekit-bsp.json');
    const mill = await write('mill-bsp.json', configuration(['java', 'scala', 'kotlin']));
    await validateSourcekitBspConfig(root, swift);
    await assert.rejects(validateSourcekitBspConfig(root, mill), /matching this connection/);
    await assert.rejects(validateSourcekitBspConfig(root, ''), /matching this connection/);
});

test('valid disabled or extensionless files still make Swift discovery ambiguous', async t => {
    for (const name of ['old.json.disabled', 'build-server-backup']) {
        const { root, write } = await workspace(t);
        const selected = await write('sourcekit-bsp.json');
        const backup = await write(name);
        await assert.rejects(validateSourcekitBspConfig(root, selected), /ambiguous/);
        await assert.rejects(validateSourcekitBspConfig(root, backup), /ambiguous/);
        await fs.rename(backup, path.join(root, name));
        await validateSourcekitBspConfig(root, selected);
    }
});

test('invalid JSON, unreadable entries, and malformed BSP schemas do not hide a valid connection', async t => {
    const { root, directory, write } = await workspace(t);
    const selected = await write('sourcekit-bsp.json');
    await fs.writeFile(path.join(directory, 'broken.json'), 'not json');
    await fs.writeFile(path.join(directory, 'broken-backup'), '{');
    await fs.mkdir(path.join(directory, 'directory.json'));
    const malformed = [null, [], 'text', 42, { languages: ['swift'] }];
    for (const field of ['name', 'version', 'bspVersion', 'languages', 'argv']) {
        const missing = configuration(); delete missing[field]; malformed.push(missing);
        malformed.push({ ...configuration(), [field]: null });
    }
    for (const field of ['name', 'version', 'bspVersion']) { malformed.push({ ...configuration(), [field]: 1 }); }
    for (const field of ['languages', 'argv']) {
        malformed.push({ ...configuration(), [field]: 'swift' });
        malformed.push({ ...configuration(), [field]: ['swift', 1] });
    }
    for (const [index, config] of malformed.entries()) {
        const invalid = await write(`malformed-${index}.json`, config);
        await validateSourcekitBspConfig(root, selected);
        await assert.rejects(validateSourcekitBspConfig(root, invalid), /matching this connection/);
    }
    await fs.unlink(selected);
    await assert.rejects(validateSourcekitBspConfig(root, selected), /matching this connection/);
});

test('multiple Swift or C-family connections never bind discovery to the first configuration', async t => {
    for (const language of ['swift', 'c', 'cpp', 'objective-c', 'objective-cpp']) {
        const { root, write } = await workspace(t);
        const first = await write('a-first.json');
        const second = await write('z-second.json', configuration([language]));
        for (const selected of [first, second]) {
            await assert.rejects(validateSourcekitBspConfig(root, selected), /ambiguous.*cannot select this connection/);
        }
        await fs.unlink(first);
        await assert.rejects(validateSourcekitBspConfig(root, first), /matching this connection/);
        await validateSourcekitBspConfig(root, second);
    }
});

test('the schema check accepts fields that the BSP decoder accepts without extra restrictions', async t => {
    const { root, write } = await workspace(t);
    const selected = await write('sourcekit.json.disabled', { ...configuration(), name: '', version: '', bspVersion: '', argv: [] });
    await validateSourcekitBspConfig(root, selected);
});
