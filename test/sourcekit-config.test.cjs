const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateSourcekitBspConfig } = require('../out/sourcekitBspConfig');

test('Swift discovery accepts a Kotlin BSP in the same folder but rejects ambiguous Swift servers', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-config-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, '.bsp');
    await fs.mkdir(directory);
    const swift = path.join(directory, 'sourcekit-bsp.json');
    const mill = path.join(directory, 'mill-bsp.json');
    await fs.writeFile(swift, JSON.stringify({ languages: ['swift', 'c'] }));
    await fs.writeFile(mill, JSON.stringify({ languages: ['java', 'scala', 'kotlin'] }));
    await fs.writeFile(path.join(directory, 'broken.json'), 'not json');
    await validateSourcekitBspConfig(root, swift);
    await assert.rejects(validateSourcekitBspConfig(root, mill), /matching this connection/);
    await fs.writeFile(path.join(directory, 'other.json'), JSON.stringify({ languages: ['cpp'] }));
    await assert.rejects(validateSourcekitBspConfig(root, swift), /one Swift\/C-family/);
});
