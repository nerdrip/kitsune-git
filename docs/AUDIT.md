# Global project audit

Audit date: 2026-07-29  
Audited version: 1.0.0-beta3

## Scope

The review covered the Electron main/preload/renderer boundaries, Git command construction, destructive operations, local file access, process spawning, persistence, repository tabs, file watching, refresh performance, dependency state, accessibility, tests, build configuration, artifact naming, auto-update configuration, launchers, documentation, and native release automation.

## Findings and applied fixes

### Security and trust boundaries

- **High — command injection in terminal launching:** repository paths were interpolated into `cmd`, `open`, or Linux shell command strings. Terminal processes now use argument-based detached spawning, fixed commands, and an active-repository path check.
- **High — renderer sandbox disabled:** `sandbox: false` was replaced with an application-wide and per-window sandbox. Context isolation remains enabled and Node integration remains disabled.
- **High — unvalidated IPC senders:** all registered handlers are now wrapped by a trusted-renderer check that verifies both the `WebContents` and exact local renderer URL.
- **High — unrestricted local file/shell IPC:** editor/reveal operations now accept only validated paths relative to the active repository. Unused external/open-path APIs were removed from the preload bridge.
- **Medium — Git argument/path injection:** repository paths, literal pathspecs, refs, remote names/URLs, commit hashes, stash indexes, counts, config values, messages, and GitFlow names now pass centralized validation. Force push uses `--force-with-lease`.
- **Medium — renderer navigation and permission surface:** navigation and popup creation are denied. Chromium permissions are denied except for sanitized clipboard writes from the trusted renderer. DevTools are available only in development mode.
- **Medium — permissive renderer policy:** the CSP is now deny-by-default and explicitly disallows remote connections, objects, frames, forms, and base URL changes.
- **Medium — unsafe HTML attribute escaping:** the renderer escape helper now covers ampersands, angle brackets, quotes, and apostrophes, including values embedded in attributes.
- **Low — excessive preload surface:** four unused APIs were removed and event subscriptions now validate callbacks and return unsubscribe functions.
- **Defense in depth:** packaged builds enable ASAR integrity/loading Electron fuses, disable `NODE_OPTIONS` and CLI inspect arguments, and disable Electron `runAsNode`.

### Correctness and data safety

- Fixed closing the active first/middle repository tab leaving the main process connected to the wrong repository.
- Opening or cloning an invalid repository no longer replaces the working Git service before the operation succeeds.
- Fixed root commits disappearing from history/search because the old newline parser discarded an empty parent field. Log records now use NUL/record separators.
- Fixed renamed commit files reporting the old path as the current path; rename similarity codes are preserved.
- Fixed GitFlow initialization on unborn repositories and stopped persisting partial GitFlow configuration before branch creation succeeds.
- Added GitFlow ref validation, clean-tree preflight checks, duplicate-tag preflight checks, safe merge argument ordering, and noninteractive rebase continuation.
- Fixed duplicate `.gitignore` entries and rejected line injection in ignore/config values.
- Restricted exposed Git config to the five settings used by the UI, preventing accidental disclosure of credential-bearing remote URLs.
- Fixed source launchers that installed production-only dependencies and then failed because Electron is a development dependency.
- Auto-update checks now run only for packaged builds with generated update metadata. The placeholder `OWNER` provider was replaced with the actual repository.

### Performance and reliability

- Repository status and local-branch reads run concurrently.
- Removed redundant `--stat` work from numeric diff statistics.
- Renderer refreshes are coalesced, and results from a previously active repository are discarded.
- Auto-fetch reuses the status already returned by `fetch` instead of issuing an extra Git process.
- Drag/drop handlers are bound once instead of once per refresh.
- Diff and history results are ignored if the active repository/selection changed while a request was running.
- The watcher now closes asynchronously before replacement, does not follow symlinks, ignores `node_modules` precisely, has no arbitrary depth-10 blind spot, and watches relevant `.git` state (`HEAD`, index, refs, rebase state) without traversing object storage.
- Window state dimensions and off-screen positions are sanitized before restoration.

### Accessibility and user experience

- Added dialog semantics, labels for icon-only close buttons, live regions for loading/toasts, keyboard-visible focus outlines, and reduced-motion support.
- Modal actions are awaited, buttons are locked during execution, and validation paths can keep a dialog open by returning `false`.
- Session/recent-repository data is schema-checked and bounded before use.

### Dependencies, tests, and maintainability

- Updated Electron 33 to 43.2.0, electron-builder 25 to 26.15.3, electron-updater to 6.8.9, simple-git to 3.36.0, and cross-env to 10.1.0.
- Pinned the fixed `js-yaml` 4.3.0 transitive version. `npm audit --omit=dev` reports zero production vulnerabilities.
- Corrected the package-lock root version mismatch and declared the actual Node.js requirement (22.12.0+).
- Added dependency-free syntax/configuration/IPC/API/CSP/build-target checks.
- Added built-in Node tests for validation plus real temporary-repository integration tests covering literal option-like paths, status, commits, diffs, root-log parsing, rename parsing, literal history search, destructive hash validation, and config filtering.

## Packaging and release automation

- Windows: NSIS installer and portable EXE.
- macOS: DMG installer and ZIP portable bundle.
- Linux: DEB/RPM installers and AppImage/tar.gz portable packages.
- Every platform supports x64 and arm64 selection.
- Target-specific Windows names prevent the NSIS and portable EXEs from overwriting each other.
- Missing generated `.ico`/`.icns` paths were replaced by the actual PNG source accepted by electron-builder.
- Added native `.bat`/`.sh` entry points for installer-only, portable-only, all-format, and all-architecture builds.
- Added a six-job GitHub Actions matrix using native Windows, macOS, and Linux runners and artifact upload.

## Product-completion pass

- Added a Git Runtime Manager with automatic/system/managed/custom selection, global and repository scopes, minimum-version validation, progress reporting, and verified managed installation.
- Added reproducible native runtime preparation. Git 2.55.0, GCM 2.9.1, and Git LFS 3.7.1 inputs are pinned by official URL and SHA-256. Each installer/portable package receives the correct platform/architecture runtime.
- Added GCM configuration plus an SSH manager for key discovery/import/generation/deletion, public-key copying, per-repository identity selection, agent load/unload, verified known-host enrollment, and connection testing.
- Added encrypted GitHub/GitLab/Bitbucket accounts, remote detection, open request listing, and PR/MR creation. Token persistence is disabled when Electron cannot provide a secure OS encryption backend.
- Added environment diagnostics with exportable sanitized reports and safe one-click repairs.
- Added partial line/hunk stage, unstage, and discard operations. Renderer-provided selections are converted to patches inside the trusted main process.
- Added a three-pane base/ours/theirs conflict center with manual resolution and generic continue/abort support for merge, rebase, cherry-pick, revert, `git am`, and KitsuneGIT interactive rebase.
- Added a validated interactive rebase planner supporting reorder, pick, reword, squash, fixup, and drop. A backup ref is created before history rewriting and abort restores the original HEAD.
- Added worktrees, reflog recovery, bisect, mailbox patch import/export, LFS, sparse checkout, scheduled/manual maintenance, repository dashboard, and reusable repository profiles.
- Added a serialized mutation queue with progress/status events, cancellation for direct Git processes, and repository-switch/runtime-change protection.
- Added a Ctrl+K command palette and an English/Polish localization foundation.

## Verification performed

- JavaScript syntax checks for all source, script, and test files.
- Static consistency checks between main IPC registrations, preload invocations, and renderer API usage.
- Git whitespace/error checks.
- Built-in unit/integration test suite against temporary real Git repositories.
- Online production dependency audit.
- Windows x64 and arm64 packaging validation for NSIS and portable artifacts, including ASAR content inspection, artifact hashes, and signature-state checks.
- Runtime smoke checks from the unpacked x64 package for Git, GCM, and Git LFS; architecture markers and required binaries were also checked in the arm64 package.
- 36 automated tests across validation, bounded process execution, patches, runtime selection, credentials, provider parsing/security, profiles, operation serialization, conflicts, and real-repository advanced Git behavior.

## Remaining external or upstream considerations

- Windows signing, Apple signing/notarization, and trusted release publishing require owner-provided certificates/tokens. Unsigned builds will trigger normal operating-system warnings.
- macOS and Linux artifacts must be verified on their native runners; a Windows host cannot reliably validate those native toolchains. The workflow provides this matrix but must run in GitHub Actions.
- The current latest electron-builder toolchain has high-severity audit findings in transitive **development-only packaging utilities** (glob/minimatch/brace expansion and related chains). They are not included in the shipped production dependency set, and npm currently offers no safe electron-builder upgrade that clears the chain; its suggested downgrade is not appropriate. Keep the builder current and review upstream releases before each public build.
- GUI end-to-end interaction and screen-reader testing still require a graphical runner/manual QA. Automated coverage currently focuses on security-sensitive validation and Git behavior.
- Public auto-update behavior depends on correctly signed GitHub release assets and generated channel metadata.
- The automated updater release command currently publishes x64 update channels only. Arm64 installers/portable packages are built by the matrix but should remain manual downloads until per-architecture update channels or universal installers are introduced.
