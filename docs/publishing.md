# Publish to Visual Studio Marketplace

The release workflow uses GitHub Actions Trusted Publishing (OIDC). It requests a
short-lived Marketplace credential and does not require a PAT secret.

## One-time setup

1. Sign in to [Manage publishers](https://marketplace.visualstudio.com/manage) with your Microsoft account.
2. Open the `lunwang` publisher, then select **Trusted Publishing → Create**.
3. Enter these policy values:

   | Field | Value |
   | --- | --- |
   | Policy name | `vscode-bsp releases` |
   | Repository owner | `aelam` |
   | Repository | `vscode-bsp` |
   | Workflow | `publish.yml` |
   | Environment | Leave empty |

4. Create the policy.

The manifest sets the Publisher ID to `lunwang`, so the extension ID is
`lunwang.vscode-bsp`. Marketplace authentication requires no PAT secret.

Git pushes use a separate credential. The repository has a dedicated Deploy Key
with write access. Its private key is stored in the `RELEASE_SSH_KEY` Actions
secret. Only the manual version preparation job uses this key.

## Master protection

Ordinary changes require a PR with both checks passing:

- `Protocol tests (ubuntu-latest)`
- `Protocol tests (macos-latest)`

The PR must be up to date with `master`, and review conversations must be resolved.
Reviewer approval is optional. The `master-pr-and-ci` ruleset allows Deploy Keys
to bypass these requirements for version commits. GitHub applies this exception
to all Deploy Keys in the repository, so additional keys would receive it too.

The separate `master-integrity` ruleset blocks force pushes and deletion. It has
no bypass actors, including the release key.

## Publish a release

1. Open **Actions → Publish extension → Run workflow** in GitHub.
2. Select `master` and choose `patch`, `minor`, or `major`.
3. Start the workflow and check its result.

The workflow calculates the next version from the commit selected for that run.
It updates `package.json` and both version entries in `package-lock.json`. It
commits these two files and pushes to `master` through the Deploy Key exception.
If `master` advances before preparation finishes, start a new run from `master`.
Start one release at a time; GitHub can replace an older pending release run.

The version commit includes a `Release-Run` marker. The push still triggers normal
CI, but the automatic publication check skips this marker to avoid a duplicate
release. The manual run continues with its specific version commit, even if
`master` later advances.

Alternatively, set a version locally with `npm version 0.1.2 --no-git-tag-version`
and merge both version files through a PR. Replace `0.1.2` with the desired version.

The workflow compares the version before and after the push to `master`. An
unchanged version skips publication. A changed version must be a higher stable
`major.minor.patch` version and must match both entries in `package-lock.json`.
Do not create a tag or GitHub Release manually.

After lint, tests, and packaging pass, the workflow creates `v<version>` at the
tested commit. It publishes the VSIX with `vsce publish --oidc`, then creates a
GitHub Release with generated notes and the same VSIX attached. The VSIX is also
saved as an Actions artifact. Only the publishing job has `contents: write` and
`id-token: write`; the version check has read access.

Tag creation and Marketplace publishing run in the same workflow.

The current version is `0.1.1`, and tag `v0.1.1` already exists. Use a higher
unused version, such as `0.1.2`, for the next release. Merging this workflow
without changing the version does not publish anything.

If a run fails after the version commit, fix the external setup issue and rerun
that run. A manual retry finds its original version commit through the run ID;
it does not increment the version again. Selecting **Run workflow** creates a
new run and requests another version increase.

A retry reuses an existing tag only when it points to the same commit. `--skip-duplicate` skips
a Marketplace version already uploaded by that run, so the GitHub Release can
still finish. Existing tags are never moved, and published versions are never
overwritten. Changes to source code require a new version.

## Local packaging and CI

```sh
npm ci
npm run test:protocol
npm run lint
npm run package
```

The package is `vscode-bsp.vsix`. `npm run install-local` packages it first and
installs that exact file. No global `vsce` installation is required.

PR CI runs tests and lint on Linux and macOS. Linux also packages the extension
and uploads a `vscode-bsp-vsix` artifact. PR CI has no publishing permission.

Packaging uses the `master` branch to rewrite README links. Demo thumbnails
remain in the package and link to the GitHub Pages video player. The **Video demos**
workflow publishes the player and original MP4 files when their files change on
`master`. Enable GitHub Pages with **GitHub Actions** as the source in repository
settings. PRs build the site without deploying it. Marketplace README changes
appear after a new extension version is published. Example projects, tests,
TypeScript sources, source maps, publishing scripts, and the editable SVG icon
are excluded. The Marketplace icon uses `media/icon.png` at 256 × 256 pixels.

See the official [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)
and [vsce Trusted Publishing documentation](https://github.com/microsoft/vscode-vsce#trusted-publishing).
