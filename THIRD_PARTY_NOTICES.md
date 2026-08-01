# Third-party runtime notices

KitsuneGIT application packages include the following command-line runtimes so the application remains usable when they are not installed system-wide:

- Git, licensed under GNU GPL version 2. The complete license text is included in `git-runtime/share/licenses/git/COPYING` (and in the Git for Windows runtime on Windows).
- Git for Windows / MinGit on Windows. Its component licenses are included in the runtime under `git-runtime/mingw64/share/licenses` and `git-runtime/usr/share/licenses` where supplied upstream.
- Git Credential Manager, version 2.9.1, licensed under the MIT License. Its upstream distribution files and notices are included either by Git for Windows or under `git-runtime/gcm`.
- Git LFS, version 3.7.1, licensed under the MIT License. Its license is included under `git-runtime/share/licenses/git-lfs`.

The exact URLs and SHA-256 digests used by reproducible builds are recorded in `src/git/runtime-manifest.json`.
