const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const GitService = require('../git/git-service');

let mainWindow;
let gitService;
let fileWatcher = null;

// ─── Window state persistence ────────────────────────────
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const data = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { width: 1400, height: 900, x: undefined, y: undefined, isMaximized: false };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isMaximized = mainWindow.isMaximized();
  const bounds = isMaximized ? (mainWindow._lastBounds || mainWindow.getBounds()) : mainWindow.getBounds();
  const state = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, isMaximized };
  try { fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state)); } catch { /* ignore */ }
}

// Cross-platform file watcher using chokidar (works on Linux, Windows, macOS)
let chokidar;
try {
  chokidar = require('chokidar');
} catch {
  chokidar = null;
}

// Auto-updater (only in production builds)
let autoUpdater;
try {
  if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'development') {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
  }
} catch {
  autoUpdater = null;
}

function setupAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `KitsuneGIT v${info.version} is available.`,
        detail: 'Would you like to download and install it?',
        buttons: ['Download', 'Later'],
        defaultId: 0
      }).then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
      });
    }
  });

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded. The app will restart to install.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    }
  });

  autoUpdater.on('error', () => {
    // Silently ignore update errors — user can update manually
  });

  // Check for updates 5 seconds after launch
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}

function createWindow() {
  const winState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: winState.width,
    height: winState.height,
    x: winState.x,
    y: winState.y,
    minWidth: 900,
    minHeight: 600,
    title: 'KitsuneGIT',
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false,
    backgroundColor: '#1e1e2e'
  });

  if (winState.isMaximized) {
    mainWindow.maximize();
  }

  // Track bounds before maximize for saving
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) mainWindow._lastBounds = mainWindow.getBounds();
  });
  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized()) mainWindow._lastBounds = mainWindow.getBounds();
  });
  mainWindow.on('close', saveWindowState);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Auto-refresh on window focus
  mainWindow.on('focus', () => {
    if (gitService && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus');
    }
  });

  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Repository...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu:open-repo')
        },
        {
          label: 'Clone Repository...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow.webContents.send('menu:clone-repo')
        },
        {
          label: 'Init Repository...',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow.webContents.send('menu:init-repo')
        },
        { type: 'separator' },
        {
          label: 'Refresh',
          accelerator: 'F5',
          click: () => mainWindow.webContents.send('menu:refresh')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Repository',
      submenu: [
        {
          label: 'Fetch',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => mainWindow.webContents.send('menu:fetch')
        },
        {
          label: 'Pull',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => mainWindow.webContents.send('menu:pull')
        },
        {
          label: 'Push',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => mainWindow.webContents.send('menu:push')
        },
        { type: 'separator' },
        {
          label: 'Create Branch...',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => mainWindow.webContents.send('menu:create-branch')
        },
        {
          label: 'Merge...',
          click: () => mainWindow.webContents.send('menu:merge')
        },
        {
          label: 'Rebase...',
          click: () => mainWindow.webContents.send('menu:rebase')
        },
        { type: 'separator' },
        {
          label: 'Stash Changes',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu:stash')
        },
        {
          label: 'Pop Stash',
          click: () => mainWindow.webContents.send('menu:stash-pop')
        },
        { type: 'separator' },
        {
          label: 'Create Tag...',
          click: () => mainWindow.webContents.send('menu:create-tag')
        }
      ]
    },
    {
      label: 'GitFlow',
      submenu: [
        {
          label: 'Initialize GitFlow...',
          click: () => mainWindow.webContents.send('menu:gitflow-init')
        },
        { type: 'separator' },
        {
          label: 'Start Feature...',
          click: () => mainWindow.webContents.send('menu:gitflow-feature-start')
        },
        {
          label: 'Finish Feature...',
          click: () => mainWindow.webContents.send('menu:gitflow-feature-finish')
        },
        { type: 'separator' },
        {
          label: 'Start Release...',
          click: () => mainWindow.webContents.send('menu:gitflow-release-start')
        },
        {
          label: 'Finish Release...',
          click: () => mainWindow.webContents.send('menu:gitflow-release-finish')
        },
        { type: 'separator' },
        {
          label: 'Start Hotfix...',
          click: () => mainWindow.webContents.send('menu:gitflow-hotfix-start')
        },
        {
          label: 'Finish Hotfix...',
          click: () => mainWindow.webContents.send('menu:gitflow-hotfix-finish')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => {
            if (autoUpdater) {
              autoUpdater.checkForUpdates().catch(() => {
                dialog.showMessageBox(mainWindow, {
                  title: 'Update Check',
                  message: 'Could not check for updates.',
                  type: 'info'
                });
              });
            } else {
              dialog.showMessageBox(mainWindow, {
                title: 'Update Check',
                message: 'Auto-updater is not available in development mode.',
                type: 'info'
              });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'About KitsuneGIT',
          click: () => {
            const pkg = require('../../package.json');
            dialog.showMessageBox(mainWindow, {
              title: 'About KitsuneGIT',
              message: `KitsuneGIT v${pkg.version}`,
              detail: 'A lightweight, fast Git GUI client.\nBuilt with Electron.',
              type: 'info'
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ─── IPC Handlers ────────────────────────────────────────────

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:selectFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── Git operations ──────────────────────────────────────────

ipcMain.handle('git:openRepo', async (_, repoPath) => {
  gitService = new GitService(repoPath);
  return await gitService.getStatus();
});

ipcMain.handle('git:initRepo', async (_, repoPath) => {
  gitService = new GitService(repoPath);
  return await gitService.init();
});

ipcMain.handle('git:clone', async (_, url, targetPath) => {
  gitService = new GitService(targetPath);
  return await gitService.clone(url, targetPath);
});

ipcMain.handle('git:status', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getStatus();
});

ipcMain.handle('git:log', async (_, maxCount) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getLog(maxCount);
});

ipcMain.handle('git:diff', async (_, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getDiff(filePath);
});

ipcMain.handle('git:diffCached', async (_, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getDiffCached(filePath);
});

ipcMain.handle('git:stage', async (_, files) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.stage(files);
});

ipcMain.handle('git:unstage', async (_, files) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.unstage(files);
});

ipcMain.handle('git:stageAll', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.stageAll();
});

ipcMain.handle('git:unstageAll', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.unstageAll();
});

ipcMain.handle('git:commit', async (_, message, amend) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.commit(message, amend);
});

ipcMain.handle('git:push', async (_, remote, branch, force) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.push(remote, branch, force);
});

ipcMain.handle('git:pull', async (_, remote, branch, rebase) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.pull(remote, branch, rebase);
});

ipcMain.handle('git:fetch', async (_, remote, prune) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.fetch(remote, prune);
});

ipcMain.handle('git:branches', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getBranches();
});

ipcMain.handle('git:createBranch', async (_, name, startPoint) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.createBranch(name, startPoint);
});

ipcMain.handle('git:deleteBranch', async (_, name, force) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.deleteBranch(name, force);
});

ipcMain.handle('git:checkout', async (_, branch) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.checkout(branch);
});

ipcMain.handle('git:merge', async (_, branch, noFf) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.merge(branch, noFf);
});

ipcMain.handle('git:rebase', async (_, branch) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.rebase(branch);
});

ipcMain.handle('git:rebaseAbort', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.rebaseAbort();
});

ipcMain.handle('git:rebaseContinue', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.rebaseContinue();
});

ipcMain.handle('git:tags', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getTags();
});

ipcMain.handle('git:createTag', async (_, name, message, commitHash) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.createTag(name, message, commitHash);
});

ipcMain.handle('git:deleteTag', async (_, name) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.deleteTag(name);
});

ipcMain.handle('git:pushTag', async (_, name, remote) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.pushTag(name, remote);
});

ipcMain.handle('git:stash', async (_, message, includeUntracked) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.stash(message, includeUntracked);
});

ipcMain.handle('git:stashList', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.stashList();
});

ipcMain.handle('git:stashPop', async (_, index) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.stashPop(index);
});

ipcMain.handle('git:stashApply', async (_, index) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.stashApply(index);
});

ipcMain.handle('git:stashDrop', async (_, index) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.stashDrop(index);
});

ipcMain.handle('git:remotes', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getRemotes();
});

ipcMain.handle('git:addRemote', async (_, name, url) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.addRemote(name, url);
});

ipcMain.handle('git:removeRemote', async (_, name) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.removeRemote(name);
});

ipcMain.handle('git:cherryPick', async (_, hash) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.cherryPick(hash);
});

ipcMain.handle('git:revert', async (_, hash) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.revert(hash);
});

ipcMain.handle('git:reset', async (_, hash, mode) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.reset(hash, mode);
});

ipcMain.handle('git:blame', async (_, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.blame(filePath);
});

ipcMain.handle('git:showCommit', async (_, hash) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.showCommit(hash);
});

ipcMain.handle('git:discardFile', async (_, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.discardChanges(filePath);
});

ipcMain.handle('git:discardUntracked', async (_, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.discardUntracked(filePath);
});

ipcMain.handle('git:discardAll', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.discardAllChanges();
});

ipcMain.handle('git:addToGitignore', async (_, pattern) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.addToGitignore(pattern);
});

ipcMain.handle('git:fileHistory', async (_, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getFileHistory(filePath);
});

ipcMain.handle('shell:openExternal', async (_, url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http/https URLs are allowed');
    }
    await shell.openExternal(url);
  } catch (err) {
    throw new Error('Invalid or disallowed URL: ' + err.message);
  }
});

ipcMain.handle('shell:showItemInFolder', async (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') throw new Error('Invalid path');
  shell.showItemInFolder(path.resolve(filePath));
});

ipcMain.handle('shell:openPath', async (_, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') throw new Error('Invalid path');
  await shell.openPath(path.resolve(dirPath));
});

ipcMain.handle('shell:openInTerminal', async (_, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') throw new Error('Invalid path');
  const resolved = path.resolve(dirPath);
  const { exec } = require('child_process');
  if (process.platform === 'win32') {
    exec(`start cmd /k "cd /d ${resolved}"`, { cwd: resolved });
  } else if (process.platform === 'darwin') {
    exec(`open -a Terminal "${resolved}"`);
  } else {
    // Try common Linux terminals
    exec(`x-terminal-emulator --working-directory="${resolved}" || xterm -e "cd '${resolved}' && bash" &`, { cwd: resolved });
  }
});

ipcMain.handle('shell:openFileInEditor', async (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') throw new Error('Invalid path');
  const resolved = path.resolve(filePath);
  await shell.openPath(resolved);
});

ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

// ─── Diff Stats ──────────────────────────────────────────

ipcMain.handle('git:diffStats', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getDiffStats();
});

ipcMain.handle('git:diffStatsCached', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getDiffStatsCached();
});

// ─── Submodules ──────────────────────────────────────────

ipcMain.handle('git:submodules', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getSubmodules();
});

ipcMain.handle('git:updateSubmodule', async (_, subPath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.updateSubmodule(subPath);
});

// ─── Git Config ──────────────────────────────────────────

ipcMain.handle('git:getConfig', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getConfig();
});

ipcMain.handle('git:setConfig', async (_, key, value) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.setConfig(key, value);
});

// ─── Search Log ──────────────────────────────────────────

ipcMain.handle('git:searchLog', async (_, query, maxCount) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.searchLog(query, maxCount);
});

// ─── Commit Files ────────────────────────────────────────

ipcMain.handle('git:commitFiles', async (_, hash) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getCommitFiles(hash);
});

ipcMain.handle('git:renameBranch', async (_, oldName, newName) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.renameBranch(oldName, newName);
});

ipcMain.handle('git:branchDiff', async (_, from, to) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getBranchDiff(from, to);
});

ipcMain.handle('git:lastCommitMessage', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getLastCommitMessage();
});

ipcMain.handle('git:commitFileDiff', async (_, hash, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getCommitFileDiff(hash, filePath);
});

// ─── GitFlow ─────────────────────────────────────────────

ipcMain.handle('git:gitflowConfig', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getGitFlowConfig();
});

ipcMain.handle('git:gitflowInit', async (_, options) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.gitFlowInit(options);
});

ipcMain.handle('git:gitflowFeatureStart', async (_, name) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.gitFlowFeatureStart(name);
});

ipcMain.handle('git:gitflowFeatureFinish', async (_, name) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.gitFlowFeatureFinish(name);
});

ipcMain.handle('git:gitflowReleaseStart', async (_, version) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.gitFlowReleaseStart(version);
});

ipcMain.handle('git:gitflowReleaseFinish', async (_, version, tagMessage) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.gitFlowReleaseFinish(version, tagMessage);
});

ipcMain.handle('git:gitflowHotfixStart', async (_, version) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.gitFlowHotfixStart(version);
});

ipcMain.handle('git:gitflowHotfixFinish', async (_, version, tagMessage) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.gitFlowHotfixFinish(version, tagMessage);
});

ipcMain.handle('git:gitflowBranches', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getGitFlowBranches();
});

ipcMain.handle('git:pushWithUpstream', async (_, remote, branch) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.pushWithUpstream(remote, branch);
});

// ─── File Watcher (cross-platform) ───────────────────────

ipcMain.handle('git:startWatcher', async (_, repoPath) => {
  stopWatcher();
  try {
    if (chokidar) {
      // chokidar works reliably on all platforms (Linux, Windows, macOS)
      fileWatcher = chokidar.watch(repoPath, {
        ignored: (filePath) => {
          const rel = path.relative(repoPath, filePath);
          // Ignore .git internals except HEAD and refs
          if (rel.startsWith('.git') && !rel.includes('HEAD') && !rel.includes('refs')) return true;
          // Ignore node_modules
          if (rel.startsWith('node_modules')) return true;
          return false;
        },
        persistent: true,
        ignoreInitial: true,
        depth: 10
      });
      fileWatcher.on('all', (event, filePath) => {
        const filename = path.relative(repoPath, filePath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('watcher:changed', filename);
        }
      });
    } else {
      // Fallback: fs.watch (recursive only works on Windows/macOS)
      const watchOptions = { persistent: true };
      if (process.platform === 'win32' || process.platform === 'darwin') {
        watchOptions.recursive = true;
      }
      fileWatcher = fs.watch(repoPath, watchOptions, (eventType, filename) => {
        if (!filename) return;
        if (filename.startsWith('.git') && !filename.includes('HEAD') && !filename.includes('refs')) return;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('watcher:changed', filename);
        }
      });
    }
  } catch { /* ignore watch errors */ }
  return true;
});

ipcMain.handle('git:stopWatcher', async () => {
  stopWatcher();
  return true;
});

function stopWatcher() {
  if (fileWatcher) {
    if (typeof fileWatcher.close === 'function') {
      fileWatcher.close();
    }
    fileWatcher = null;
  }
}

// ─── App lifecycle ───────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  stopWatcher();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
