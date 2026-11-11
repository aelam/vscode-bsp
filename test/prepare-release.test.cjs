const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nextVersion, prepareManualRelease } = require('../scripts/prepare-release.cjs');
const { planFromGit } = require('../scripts/check-release.cjs');

function fixture(t) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-manual-release-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'checkout');
    const remote = path.join(temporary, 'remote.git');
    fs.mkdirSync(root);
    const environment = { ...process.env, npm_config_cache: path.join(temporary, 'npm-cache') };
    const git = (...args) => execFileSync('git', [
        '-c', 'user.name=Release Tests', '-c', 'user.email=release-tests@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args
    ], { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '--bare', remote);
    git('init', '-b', 'master');
    git('config', 'core.hooksPath', path.join(temporary, 'no-hooks'));
    git('remote', 'add', 'origin', remote);
    const manifest = { name: 'release-fixture', publisher: 'lunwang', version: '0.1.1' };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
        name: manifest.name, version: manifest.version, lockfileVersion: 3,
        requires: true, packages: { '': { name: manifest.name, version: manifest.version } }
    }, null, 2) + '\n');
    git('add', '.');
    git('commit', '-m', 'Add release fixture');
    git('push', '-u', 'origin', 'master');
    const baseCommit = git('rev-parse', 'HEAD');
    const options = { bump: 'patch', runId: '12345', baseCommit };
    const prepare = (overrides = {}) => prepareManualRelease(root, { ...options, ...overrides }, environment);
    return { root, remote, git, baseCommit, prepare };
}

test('manual releases increment the selected component and reset smaller components', () => {
    assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
    for (const bump of [undefined, '', 'prerelease', 'toString']) {
        assert.throws(() => nextVersion('1.2.3', bump), /Choose patch, minor, or major/);
    }
    assert.throws(() => nextVersion('1.2.3-beta.1', 'patch'), /stable major.minor.patch/);
});

test('manual preparation pushes only the two version files and skips duplicate push publication', t => {
    const { root, remote, git, baseCommit, prepare } = fixture(t);
    const plan = prepare();
    assert.deepEqual(plan, { shouldPublish: true, tag: 'v0.1.2', commit: git('rev-parse', 'HEAD') });
    assert.equal(git('--git-dir', remote, 'rev-parse', 'master'), plan.commit);
    assert.equal(git('rev-parse', `${plan.commit}^`), baseCommit);
    assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', plan.commit).split('\n'), [
        'package-lock.json', 'package.json'
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
    assert.equal(manifest.version, '0.1.2');
    assert.equal(lockfile.version, '0.1.2');
    assert.equal(lockfile.packages[''].version, '0.1.2');
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('tag', '--list'), '');
    assert.deepEqual(planFromGit(root, baseCommit), { shouldPublish: false, tag: 'v0.1.2' });
});

test('a retry reuses the original version commit even after master advances', t => {
    const { root, git, baseCommit, prepare } = fixture(t);
    const original = prepare();
    assert.deepEqual(prepare(), original);
    git('tag', '-a', original.tag, '-m', 'Fixture release', original.commit);
    git('push', 'origin', `refs/tags/${original.tag}`);
    fs.writeFileSync(path.join(root, 'README.md'), 'Release fixture\n');
    git('add', 'README.md');
    git('commit', '-m', 'Advance master');
    git('push', 'origin', 'master');
    const advanced = git('rev-parse', 'HEAD');
    git('checkout', '--detach', baseCommit);
    assert.deepEqual(prepare(), original);
    assert.equal(git('rev-parse', 'origin/master'), advanced);
    assert.equal(git('rev-parse', 'HEAD'), baseCommit);
    assert.throws(() => prepare({ bump: 'minor' }), /does not match this release run/);
});

test('a stale release request cannot change master', t => {
    const { git, baseCommit, prepare } = fixture(t);
    git('commit', '--allow-empty', '-m', 'Advance master');
    git('push', 'origin', 'master');
    const advanced = git('rev-parse', 'HEAD');
    git('checkout', '--detach', baseCommit);
    assert.throws(() => prepare(), /master advanced/);
    assert.equal(git('rev-parse', 'origin/master'), advanced);
    assert.equal(git('status', '--porcelain'), '');
});

test('a new release cannot reuse a tag or include local changes', t => {
    const { root, git, baseCommit, prepare } = fixture(t);
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'local change');
    assert.throws(() => prepare(), /clean checkout/);
    fs.unlinkSync(path.join(root, 'untracked.txt'));
    git('tag', 'v0.1.2');
    assert.throws(() => prepare(), /Tag v0.1.2 already exists/);
    assert.equal(git('rev-parse', 'HEAD'), baseCommit);
    assert.equal(git('status', '--porcelain'), '');
});

test('a retry rejects a tag that points to another commit', t => {
    const { git, baseCommit, prepare } = fixture(t);
    prepare();
    git('tag', 'v0.1.2', baseCommit);
    assert.throws(() => prepare(), /already points to another commit/);
});

test('a retry rejects an unrelated commit with the release marker', t => {
    const { root, git, prepare } = fixture(t);
    fs.writeFileSync(path.join(root, 'README.md'), 'Release fixture\n');
    git('add', 'README.md');
    git('commit', '-m', 'Unrelated change', '-m', 'Release-Run: 12345');
    git('push', 'origin', 'master');
    assert.throws(() => prepare(), /does not match this release run/);
});

test('release preparation requires a valid run ID and base commit', t => {
    const { prepare } = fixture(t);
    assert.throws(() => prepare({ runId: '0' }), /run ID and base commit/);
    assert.throws(() => prepare({ baseCommit: 'master' }), /run ID and base commit/);
});
