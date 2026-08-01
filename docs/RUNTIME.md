# Managed Git runtime

KitsuneGIT can use four runtime modes:

- **Automatic** — prefer a supported system Git, then use the managed/bundled runtime.
- **System** — require Git discovered through the operating system.
- **Managed** — require the runtime shipped with or downloaded by KitsuneGIT.
- **Custom** — use a user-selected executable after path, version, and minimum-version validation.

The selection can be global or overridden per repository. The status bar and Settings dialog always show the actual executable and version in use.

## Supply-chain controls

`src/git/runtime-manifest.json` pins the Git, Git for Windows, Git Credential Manager, and Git LFS versions, official HTTPS URLs, and SHA-256 digests. `scripts/prepare-git-runtime.js` refuses an archive whose digest differs.

Windows uses the official MinGit ZIP. macOS and Linux build the official Git source tarball on a native runner, then add the matching native GCM and Git LFS distributions. electron-builder copies only `build/runtime/<platform>-<arch>` to `resources/git-runtime`.

## Runtime layout

```text
git-runtime/
  cmd/git.exe              # Windows
  bin/git                  # macOS/Linux
  bin/git-lfs*             # macOS/Linux; cmd/ on Windows
  gcm/                     # when GCM is not already supplied by Git
  share/licenses/
  .kitsune-runtime.json
```

KitsuneGIT prepends only the selected runtime directories to the child-process `PATH`, sets Git executable/template paths where necessary, and disables terminal credential prompting in background operations. Interactive SSH key generation and agent unlocks are launched in a visible terminal owned by the user.

## Native build dependencies

Linux source builds require a compiler, make, libcurl/OpenSSL, zlib, and expat development packages. The GitHub Actions workflow installs them explicitly. macOS uses the native Xcode command-line toolchain. Windows runtime archives do not require compilation.

## Updating the runtime

Update versions, URLs, and hashes together in the manifest, run the preparation script for a native architecture, verify `git --version`, `git credential-manager --version`, and `git lfs version`, then rebuild all package targets. Never update a URL without independently verifying its upstream digest.
