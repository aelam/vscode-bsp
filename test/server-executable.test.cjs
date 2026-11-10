const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findExecutable } = require('../out/serverExecutable');

test('finds executable files on PATH and ignores directories and non-executable files', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsp-executable-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.mkdir(path.join(first, 'sourcekit-bsp'));
    const binary = path.join(second, 'sourcekit-bsp');
    await fs.writeFile(binary, '', { mode: 0o755 });
    assert.equal(await findExecutable('sourcekit-bsp', [first, second].join(path.delimiter)), binary);
    await fs.chmod(binary, 0o644);
    assert.equal(await findExecutable('sourcekit-bsp', [first, second].join(path.delimiter)), undefined);
});
