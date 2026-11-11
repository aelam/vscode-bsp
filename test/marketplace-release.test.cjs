const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkRelease, releasePlan, planFromGit } = require('../scripts/check-release.cjs');

const manifest = { name: 'vscode-bsp', publisher: 'lunwang', version: '0.1.1' };
const lock = version => ({ version, packages: { '': { version } } });

test('release validation accepts the matching version and registered publisher', () => {
    assert.doesNotThrow(() => checkRelease(manifest, 'v0.1.1'));
});

test('release validation rejects tags that differ from the package version', () => {
    for (const tag of [undefined, '', '0.1.1', 'v0.1.2', 'v0.1.1-beta.1']) {
        assert.throws(() => checkRelease(manifest, tag), /Release tag must be v0\.1\.1/);
    }
});

test('release validation requires a valid publisher ID', () => {
    for (const publisher of [undefined, '', ' ', 'display name', '-publisher', 'publisher\n']) {
        assert.throws(() => checkRelease({ ...manifest, publisher }, 'v0.1.1'), /valid Marketplace publisher ID/);
    }
});

test('unchanged versions do not publish even when the previous tag points to an older commit', () => {
    assert.deepEqual(releasePlan(manifest, '0.1.1', lock('0.1.1'), 'new', 'old'), {
        shouldPublish: false, tag: 'v0.1.1'
    });
});

test('patch, minor, and major increases select the new version tag', () => {
    for (const [previous, version] of [['0.1.1', '0.1.2'], ['0.1.9', '0.1.10'], ['0.1.9', '0.2.0'], ['0.9.9', '1.0.0'], [undefined, '0.1.1']]) {
        assert.deepEqual(releasePlan({ ...manifest, version }, previous, lock(version), 'head'), {
            shouldPublish: true, tag: `v${version}`
        });
    }
});

test('version decreases and non-stable versions cannot trigger publication', () => {
    assert.throws(() => releasePlan(manifest, '0.2.0', lock('0.1.1'), 'head'), /must be greater/);
    for (const version of ['0.1.2-beta.1', '0.1.2+build', '01.2.3', '1.2', '1.2.3\n']) {
        assert.throws(() => releasePlan({ ...manifest, version }, '0.1.1', lock(version), 'head'), /stable major.minor.patch/);
    }
});

test('both lockfile version entries must match the manifest', () => {
    for (const lockfile of [lock('0.1.0'), { version: '0.1.1' }, { version: '0.1.1', packages: { '': { version: '0.1.0' } } }]) {
        assert.throws(() => releasePlan(manifest, '0.1.0', lockfile, 'head'), /package-lock.json must have the same version/);
    }
});

test('retries can reuse the same commit tag but cannot move an existing tag', () => {
    assert.equal(releasePlan(manifest, '0.1.0', lock('0.1.1'), 'head', 'head').shouldPublish, true);
    assert.throws(() => releasePlan(manifest, '0.1.0', lock('0.1.1'), 'head', 'other'), /already points to another commit/);
});

test('Git comparison covers the entire push and resolves annotated tags', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-release-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', [
        '-c', 'user.name=Release Tests', '-c', 'user.email=release-tests@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const writeVersion = version => {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...manifest, version }));
        fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock(version)));
        git('add', 'package.json', 'package-lock.json');
        git('commit', '-m', 'Set fixture version');
        return git('rev-parse', 'HEAD');
    };
    git('init');
    const before = writeVersion('0.1.1');
    const bumped = writeVersion('0.1.2');
    fs.writeFileSync(path.join(root, 'README.md'), 'Fixture');
    git('add', 'README.md');
    git('commit', '-m', 'Add fixture document');
    assert.deepEqual(planFromGit(root, before), { shouldPublish: true, tag: 'v0.1.2' });
    assert.equal(planFromGit(root, bumped).shouldPublish, false);
    git('tag', '-a', 'v0.1.2', '-m', 'Fixture release');
    assert.equal(planFromGit(root, before).shouldPublish, true);
    git('commit', '--allow-empty', '-m', 'Advance fixture');
    assert.throws(() => planFromGit(root, before), /already points to another commit/);
    assert.throws(() => planFromGit(root, undefined), /BEFORE_SHA/);
    assert.throws(() => planFromGit(root, 'f'.repeat(40)), /Command failed/);
});
