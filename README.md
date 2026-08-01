# KitsuneGIT 🦊

[![Continuous integration](https://github.com/nerdrip/kitsune-git/actions/workflows/ci.yml/badge.svg)](https://github.com/nerdrip/kitsune-git/actions/workflows/ci.yml)
[![Build and publish release](https://github.com/nerdrip/kitsune-git/actions/workflows/build-packages.yml/badge.svg)](https://github.com/nerdrip/kitsune-git/actions/workflows/build-packages.yml)
[![Latest release](https://img.shields.io/github/v/release/nerdrip/kitsune-git?include_prereleases&sort=semver)](https://github.com/nerdrip/kitsune-git/releases)

KitsuneGIT is a cross-platform Git desktop client built with Electron and `simple-git`. Release packages are self-contained: they include a verified Git runtime, Git Credential Manager, Git LFS, and OpenSSH tooling, while still allowing a system or custom Git executable to be selected globally or per repository.

Highlights include visual Git automations, conditional app hooks, partial line/hunk staging, a three-pane conflict editor, interactive rebase with recovery refs, worktrees, reflog recovery, bisect, mailbox patches, sparse checkout, maintenance, GitFlow, repository profiles, encrypted GitHub/GitLab/Bitbucket tokens, pull-request management, SSH key/agent/known-host management, diagnostics, command palette, and English/Polish UI foundations.

## Automation Studio

Automation Studio turns repeatable Git sequences into one-click, validated workflows. It includes a ready-to-use `Develop → Main` macro that stages changes, asks for a commit message, commits and pushes `develop`, updates `main`, merges and pushes it, then returns to `develop`.

Workflows are assembled from visual blocks for staging, commit, fetch, pull, push, checkout, merge, requirements, and nested `if / else` decisions. Blocks support `${startBranch}`, `${currentBranch}`, and `${commitMessage}` variables, can be global or repository-specific, and always stop on the first Git error or merge conflict. They never execute arbitrary shell text.

An automation can run manually or as an app-level `after commit` hook with optional commit-message or branch conditions. Hook failures are reported separately after the commit succeeds, so a successful commit is never shown as failed. These hooks run for commits created in KitsuneGIT; they do not modify a repository's native `.git/hooks` directory.

## Requirements

- Node.js 22.12.0 or newer for development/building (Node.js 22 LTS is recommended)
- A native build host for release packages: Windows for NSIS/portable EXE, macOS for DMG/ZIP, and Linux for DEB/RPM/AppImage/tar.gz

End users do not need to install Git separately. In automatic mode KitsuneGIT prefers a supported system Git and falls back to the bundled runtime. Settings allow `Automatic`, `System`, `Managed`, or `Custom` selection, with an optional per-repository override.

## Development

```bash
npm ci
npm run dev
```

Convenience launchers are also included:

- Windows: `start-dev.bat` and `start.bat`
- Linux/macOS: `./start-dev.sh` and `./start.sh`

Run the complete local verification before committing:

```bash
npm run verify
```

This performs syntax/configuration/IPC consistency checks and the Node integration test suite.

## Release packages

Package builds run verification first, regenerate platform icons, download/build the pinned native Git runtime, verify every download with SHA-256, and write artifacts plus `SHA256SUMS.txt` to `dist/`.

| Platform | Installer | Portable | Architectures |
| --- | --- | --- | --- |
| Windows | NSIS setup EXE | Portable EXE | x64, arm64 |
| macOS | DMG | ZIP containing `.app` | x64, arm64 |
| Linux | DEB, RPM | AppImage, tar.gz | x64, arm64 |

### Windows

```bat
build-installer.bat x64
build-portable.bat x64
build-windows.bat all all
```

The first argument to `build-windows.bat` is `installer`, `portable`, or `all`; the second is `x64`, `arm64`, or `all`. `build-release.bat` remains as a compatibility alias for all Windows formats and architectures.

### Linux

```bash
chmod +x build-*.sh
./build-installer.sh x64
./build-portable.sh x64
./build-linux.sh all all
```

### macOS

```bash
chmod +x build-*.sh
./build-installer.sh arm64
./build-portable.sh arm64
./build-macos.sh all all
```

### npm and advanced usage

```bash
npm run build:win
npm run build:linux
npm run build:mac
npm run build:all       # every format and architecture for the native host

node scripts/build-packages.js --help
```

Reliable packages for all operating systems cannot be produced on one host because macOS packaging/signing requires macOS and platform toolchains differ. The six-job matrix in `.github/workflows/build-packages.yml` builds x64 and arm64 artifacts for Windows, macOS, and Linux. macOS and Linux use native runners; Windows ARM64 is cross-built on the stable Windows x64 runner because electron-builder's icon helper is currently unreliable on GitHub's native Windows ARM runner.

The runtime build inputs are pinned in `src/git/runtime-manifest.json`. Windows packages use the official MinGit ZIP; macOS/Linux jobs build the official Git source release natively. GCM and Git LFS native archives are included when the platform Git distribution does not already provide them. See [docs/RUNTIME.md](docs/RUNTIME.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Signing, notarization, and publishing

Unsigned local packages are suitable for testing. Public distribution should provide platform credentials through the standard electron-builder environment variables:

- Windows/macOS signing: `CSC_LINK` and `CSC_KEY_PASSWORD`, or separate `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` and `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` secrets
- Apple notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
- Local GitHub publishing: `GH_TOKEN` (GitHub Actions receives its scoped token automatically)

`npm run release` publishes x64 packages for the current native host and requires release credentials. It intentionally uses one architecture so update metadata cannot be overwritten by a second architecture; arm64 packages can still be built and uploaded separately. Normal build commands use `--publish never`. The updater targets `nerdrip/kitsune-git` GitHub releases and starts only in packaged builds containing update metadata.

### Automatic GitHub releases

GitHub Actions verifies pull requests and pushes on Windows, macOS, and Linux. A release build starts when a `v*` tag is pushed or when a version change in `package.json` is merged to `main`. The workflow builds x64 and ARM64 packages for all three systems, verifies that every expected installer and portable archive exists, combines the artifacts, generates `SHA256SUMS.txt`, and creates the corresponding GitHub Release automatically. Versions containing a suffix such as `-beta5` are marked as prereleases.

Publishing is all-or-nothing: GitHub Release is created only after verification and all six package jobs pass, so users never see a silently incomplete release. If a run fails before creating the release, merging a fix to the release workflow, package script, runtime manifest, lockfile, or build resources automatically retries the still-missing current version even when its number did not change. This is how `1.0.0-beta5` will recover after the CI fix is merged.

If a release for the package version already exists, an ordinary merge does not replace it. To repair or intentionally replace its assets, open **Actions → Build and publish release → Run workflow**, enable `rebuild_existing`, and run it from `main`. Signing and Apple notarization are enabled automatically when the repository secrets listed above are configured; otherwise the workflow produces unsigned test/community packages.

## Security model

- Electron renderer sandbox and context isolation are enabled; Node integration is disabled.
- Every IPC request is checked against the trusted local renderer.
- Navigation and popups are denied. Chromium permissions are denied except for sanitized clipboard writes from the trusted renderer.
- The renderer uses a deny-by-default Content Security Policy.
- Shell/file actions are limited to the active repository; terminal launching does not interpolate untrusted paths into a host shell.
- Git paths use literal pathspecs and repository-relative validation; refs, remotes, hashes, stash indexes, config values, and GitFlow names are validated.
- HTTPS provider tokens are encrypted with Electron `safeStorage`; persistence is refused when the OS only exposes an unencrypted backend. Tokens are never returned to the renderer after saving.
- Git mutations are serialized in an operation queue. Direct child-process operations receive an abort signal and repository switching is blocked while a mutation is active.
- Production dependencies currently pass `npm audit --omit=dev` with zero known vulnerabilities.

See [docs/AUDIT.md](docs/AUDIT.md) for the detailed audit, applied fixes, verification, and remaining release considerations.

## Project structure

```text
src/automation/            Persisted visual macro validation, conditions, and safe execution
src/main/                  Electron lifecycle, secure IPC, operation queue, diagnostics, profiles
src/main/preload.js        Minimal context-bridge API
src/git/                   Git service, runtime manager, patches, and validation
src/auth/                  GCM, SSH keys, agent, and known-host manager
src/integrations/          Encrypted Git hosting integrations
src/renderer/              HTML, CSS, and renderer application
scripts/check-project.js   Dependency-free static/project checks
scripts/build-packages.js  Cross-platform package orchestration
scripts/prepare-git-runtime.js  Verified native Git/GCM/LFS preparation
scripts/generate-icons.js  PNG/Linux icon generation
test/                      Validation and real-Git integration tests
build/                     Application icons and build resources
.github/workflows/         Native package matrix
```

## License

KitsuneGIT is MIT licensed. Bundled runtime components retain their respective upstream licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
