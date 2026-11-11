const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { versionParts, releasePlan } = require('./check-release.cjs');

function nextVersion(version, bump) {
    const parts = versionParts(version);
    const index = { major: 0, minor: 1, patch: 2 }[bump];
    if (!['major', 'minor', 'patch'].includes(bump)) {
        throw new Error('Choose patch, minor, or major.');
    }
    parts[index] += 1n;
    return parts.map((value, part) => part > index ? 0n : value).join('.');
}

function prepareManualRelease(root, { bump, runId, baseCommit }, environment = process.env) {
    if (!/^[1-9]\d*$/.test(runId ?? '') || !/^[a-f0-9]{40}$/.test(baseCommit ?? '')) {
        throw new Error('A GitHub run ID and base commit are required.');
    }
    const run = (command, args) => execFileSync(command, args, {
        cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    const git = (...args) => run('git', args);
    const readJSON = (commit, file) => JSON.parse(git('show', `${commit}:${file}`));
    const resolveTag = tag => {
        try { return git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`); }
        catch (error) { if (error.status !== 1) { throw error; } }
    };
    const previous = readJSON(baseCommit, 'package.json');
    const version = nextVersion(previous.version, bump);
    const tag = `v${version}`;
    const marker = `Release-Run: ${runId}`;
    git('fetch', 'origin', 'master');

    const matches = git('log', 'origin/master', '--format=%H', '--fixed-strings', '--grep', marker)
        .split('\n').filter(commit => commit && git('show', '-s', '--format=%B', commit).split('\n').includes(marker));
    if (matches.length > 1) { throw new Error('More than one version commit matches this release run.'); }
    if (matches.length === 1) {
        const commit = matches[0];
        const manifest = readJSON(commit, 'package.json');
        const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n').sort();
        if (git('rev-parse', `${commit}^`) !== baseCommit || manifest.version !== version
            || JSON.stringify(changed) !== JSON.stringify(['package-lock.json', 'package.json'])) {
            throw new Error('The existing version commit does not match this release run.');
        }
        const plan = releasePlan(manifest, previous.version, readJSON(commit, 'package-lock.json'), commit, resolveTag(tag));
        return { ...plan, commit };
    }

    if (git('rev-parse', 'HEAD') !== baseCommit || git('rev-parse', 'origin/master') !== baseCommit) {
        throw new Error('master advanced after this run was started. Start a new release run from master.');
    }
    if (git('status', '--porcelain')) { throw new Error('Release preparation requires a clean checkout.'); }
    if (resolveTag(tag)) { throw new Error(`Tag ${tag} already exists. Choose a new version.`); }

    run('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts']);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const plan = releasePlan(manifest, previous.version, lockfile, baseCommit);
    git('add', 'package.json', 'package-lock.json');
    git('-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        '-c', 'commit.gpgsign=false', 'commit', '-m', `chore(release): ${tag}`, '-m', marker);
    const commit = git('rev-parse', 'HEAD');
    git('push', 'origin', 'HEAD:refs/heads/master');
    return { ...plan, commit };
}

if (require.main === module) {
    try {
        if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
            || process.env.GITHUB_REF !== 'refs/heads/master') {
            throw new Error('Run manual release preparation through GitHub Actions on master.');
        }
        const plan = prepareManualRelease(path.resolve(__dirname, '..'), {
            bump: process.env.BUMP_TYPE, runId: process.env.GITHUB_RUN_ID, baseCommit: process.env.GITHUB_SHA
        });
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_publish=${plan.shouldPublish}\ntag=${plan.tag}\ncommit=${plan.commit}\n`);
        }
        console.log(`Prepared ${plan.tag} at ${plan.commit}.`);
    } catch (error) {
        console.error(error.message);
        if (error.stderr) { console.error(String(error.stderr)); }
        process.exitCode = 1;
    }
}

module.exports = { nextVersion, prepareManualRelease };
