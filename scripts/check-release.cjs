const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function versionParts(version) {
    if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error(`Expected a stable major.minor.patch version; received ${JSON.stringify(version)}.`);
    }
    return version.split('.').map(BigInt);
}

function checkRelease(manifest, tag) {
    versionParts(manifest.version);
    if (tag !== `v${manifest.version}`) {
        throw new Error(`Release tag must be v${manifest.version}; received ${JSON.stringify(tag)}.`);
    }
    if (typeof manifest.publisher !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(manifest.publisher)) {
        throw new Error('Set a valid Marketplace publisher ID in package.json.');
    }
}

function releasePlan(manifest, previousVersion, lockfile, commit, tagCommit) {
    const tag = `v${manifest.version}`;
    checkRelease(manifest, tag);
    if (lockfile.version !== manifest.version || lockfile.packages?.['']?.version !== manifest.version) {
        throw new Error('package.json and package-lock.json must have the same version. Use npm version --no-git-tag-version.');
    }
    if (previousVersion === manifest.version) {
        return { shouldPublish: false, tag };
    }
    if (previousVersion !== undefined) {
        const previous = versionParts(previousVersion);
        const current = versionParts(manifest.version);
        const difference = current.findIndex((value, index) => value !== previous[index]);
        if (difference < 0 || current[difference] < previous[difference]) {
            throw new Error(`Version ${manifest.version} must be greater than ${previousVersion}.`);
        }
    }
    if (tagCommit && tagCommit !== commit) {
        throw new Error(`Tag ${tag} already points to another commit. Choose a new version; existing tags are not moved.`);
    }
    return { shouldPublish: true, tag };
}

function planFromGit(root, before) {
    if (!/^[a-f0-9]{40}$/.test(before ?? '')) {
        throw new Error('BEFORE_SHA must be the commit before the push to master.');
    }
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    checkRelease(manifest, `v${manifest.version}`);
    const previousVersion = /^0{40}$/.test(before)
        ? undefined : JSON.parse(git('show', `${before}:package.json`)).version;
    const commit = git('rev-parse', 'HEAD');
    let tagCommit;
    try {
        tagCommit = git('rev-parse', '--verify', '--quiet', `refs/tags/v${manifest.version}^{commit}`);
    } catch (error) {
        if (error.status !== 1) { throw error; }
    }
    const plan = releasePlan(manifest, previousVersion, lockfile, commit, tagCommit);
    if (/^Release-Run: [1-9]\d*$/m.test(git('show', '-s', '--format=%B', commit))) {
        return { ...plan, shouldPublish: false };
    }
    return plan;
}

if (require.main === module) {
    try {
        const plan = planFromGit(path.resolve(__dirname, '..'), process.env.BEFORE_SHA);
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim();
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_publish=${plan.shouldPublish}\ntag=${plan.tag}\ncommit=${commit}\n`);
        }
        console.log(plan.shouldPublish ? `Release ${plan.tag}.` : `No automatic release needed; skip ${plan.tag}.`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { versionParts, checkRelease, releasePlan, planFromGit };
