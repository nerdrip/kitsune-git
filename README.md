# KitsuneGIT 🦊

A lightweight, fast, universal **Git GUI client** — built with Electron.  
Inspired by SourceTree, designed to be faster and cross-platform.

## Features

### Complete Git Operations
- **Repository**: Open, Clone, Init
- **Staging**: Stage/Unstage files individually or all at once, discard changes
- **Commit**: Commit with message, amend support, conventional commits
- **Push / Pull / Fetch**: Full remote sync with rebase option
- **Branches**: Create, delete, checkout, rename (local & remote)
- **Merge & Rebase**: Merge with --no-ff, rebase, abort/continue rebase
- **Tags**: Create (lightweight & annotated), delete
- **Stash**: Stash, list, pop, drop
- **Remotes**: Add, remove, view
- **Cherry-pick**: Apply specific commits
- **Revert**: Revert commits
- **Reset**: Soft, mixed, hard reset to any commit
- **Blame**: Line-by-line annotation
- **File History**: View commit history for any file
- **Diff Viewer**: Inline and side-by-side diff with syntax highlighting

### Visual Interface
- Dark/Light Catppuccin-inspired theme (toggle with one click)
- SourceTree-like layout with sidebar (branches, tags, stashes, remotes)
- Dual file status panel (staged/unstaged) with inline diff viewer
- Commit history table with graph, refs, and commit detail pane
- Multi-tab repository support
- Context menus on files, branches, tags, stashes, commits
- Drag & drop staging
- Modal dialogs for complex operations
- Toast notifications
- Resizable sidebar
- Keyboard shortcuts
- File watcher with auto-refresh
- Recent repositories list
- Auto-updater for production builds

### Cross-Platform
- **Windows**: NSIS installer + portable executable
- **Linux**: AppImage + .deb + .rpm + .tar.gz
- Cross-platform file watching (chokidar)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ 
- [Git](https://git-scm.com/) installed and in PATH

## Quick Start

### Windows

```bash
# Option 1: Use the batch scripts
start-dev.bat          # Development mode (with DevTools)
start.bat              # Production mode

# Option 2: Manual
npm install
npm run dev            # Development
npm start              # Production
```

### Linux

```bash
# Option 1: Use the shell scripts
chmod +x start-dev.sh build-release.sh
./start-dev.sh         # Development mode
./start.sh             # Production mode

# Option 2: Manual
npm install
npm run dev            # Development
npm start              # Production
```

## Building Release Packages

### Windows (from Windows)

```bash
# Using the build script:
build-release.bat

# Or manually:
npm install
npm run build:win
```

**Output** (`dist/` folder):
- `KitsuneGIT-1.0.0-beta1-win-x64.exe` — NSIS installer (with desktop shortcut, start menu, uninstaller)
- `KitsuneGIT-1.0.0-beta1-win-x64-portable.exe` — Portable executable (no install needed)

### Linux (from Linux)

```bash
# Using the build script:
chmod +x build-release.sh
./build-release.sh

# Or manually:
npm install
npm run build:linux
```

**Output** (`dist/` folder):
- `KitsuneGIT-1.0.0-beta1-linux-x64.AppImage` — Universal Linux package (run anywhere)
- `KitsuneGIT-1.0.0-beta1-linux-x64.deb` — Debian/Ubuntu package
- `KitsuneGIT-1.0.0-beta1-linux-x64.rpm` — Fedora/RHEL package
- `KitsuneGIT-1.0.0-beta1-linux-x64.tar.gz` — Generic archive

### Both Platforms at Once

```bash
npm run build:all
```

This will build for Windows + Linux.

## App Icons

Icons are auto-generated on first build via `npm run generate-icons`.  
To use a custom icon, replace `build/icon.png` with your own 512x512 PNG.  
`electron-builder` auto-generates `.ico` and `.icns` from it.

## Project Structure

```
KitsuneGIT/
├── build/
│   └── icon.png               # App icon (auto-generated or custom)
├── scripts/
│   └── generate-icons.js      # Icon generation script
├── src/
│   ├── main/
│   │   ├── main.js            # Electron main process
│   │   └── preload.js         # Context bridge (IPC)
│   ├── git/
│   │   └── git-service.js     # Git operations (simple-git wrapper)
│   └── renderer/
│       ├── index.html         # UI shell
│       ├── styles.css         # Dark/Light theme styles
│       └── app.js             # Frontend logic
├── start.bat / start.sh       # Production launchers
├── start-dev.bat / start-dev.sh  # Development launchers
├── build-release.bat / build-release.sh  # Build scripts
├── package.json
├── LICENSE
└── README.md
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run the app in production mode |
| `npm run dev` | Run with DevTools open |
| `npm run build:win` | Build Windows installer + portable |
| `npm run build:linux` | Build Linux AppImage + deb + rpm + tar.gz |
| `npm run build:all` | Build for all platforms |
| `npm run release` | Build + publish release |
| `npm run generate-icons` | Generate app icons from source |
| `npm run pack` | Package without creating installer (for testing) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+O` | Open Repository |
| `Ctrl+Shift+O` | Clone Repository |
| `Ctrl+Shift+N` | Init New Repository |
| `F5` | Refresh |
| `Ctrl+Shift+F` | Fetch |
| `Ctrl+Shift+P` | Pull |
| `Ctrl+Shift+U` | Push |
| `Ctrl+Shift+B` | Create Branch |
| `Ctrl+Shift+S` | Stash |
| `Ctrl+Shift+G` | GitFlow menu |
| `Ctrl+Enter` | Commit |
| `Ctrl+1` | File Status View |
| `Ctrl+2` | History View |
| `↑` / `↓` | Navigate files |
| `?` | Keyboard Shortcuts |

## Tech Stack

- **Electron** — Cross-platform desktop app
- **simple-git** — Node.js Git interface
- **chokidar** — Cross-platform file watching
- **electron-builder** — Packaging & distribution
- **electron-updater** — Auto-update support

## License

MIT
