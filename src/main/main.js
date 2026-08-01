const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain: electronIpcMain,
  Menu,
  screen,
  session,
  safeStorage,
  shell
} = require('electron');
const GitService = require('../git/git-service');
const { GitRuntimeManager } = require('../git/runtime-manager');
const { CredentialManager } = require('../auth/credential-manager');
const { DiagnosticsService } = require('./diagnostics');
const { ProviderManager } = require('../integrations/provider-manager');
const { MacroManager } = require('../automation/macro-manager');
const { MacroRunner } = require('../automation/macro-runner');
const { OperationQueue } = require('./operation-queue');
const { ProfileManager } = require('./profile-manager');
const { normalizeRelativePath, normalizeRepositoryPath } = require('../git/validation');

const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');
const RENDERER_URL = pathToFileURL(RENDERER_FILE).href;
const isDevelopment = process.env.NODE_ENV === 'development';

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL();
  if (!mainWindow || event.sender !== mainWindow.webContents || senderUrl !== RENDERER_URL) {
    throw new Error('Blocked IPC request from an untrusted renderer');
  }
}

const MUTATING_GIT_CHANNELS = new Set([
  'git:initRepo', 'git:clone', 'git:applySelection', 'git:stage', 'git:unstage', 'git:stageAll', 'git:unstageAll',
  'git:commit', 'git:push', 'git:pull', 'git:fetch', 'git:createBranch', 'git:deleteBranch', 'git:checkout',
  'git:merge', 'git:rebase', 'git:startInteractiveRebase', 'git:saveConflictResolution', 'git:resolveConflictUsing', 'git:continueOperation',
  'git:abortOperation', 'git:createTag', 'git:deleteTag', 'git:pushTag', 'git:stash', 'git:stashPop',
  'git:stashApply', 'git:stashDrop', 'git:addRemote', 'git:removeRemote', 'git:cherryPick', 'git:revert',
  'git:reset', 'git:discardFile', 'git:discardUntracked', 'git:discardAll', 'git:addToGitignore',
  'git:updateSubmodule', 'git:setConfig', 'git:renameBranch', 'git:gitflowInit', 'git:gitflowFeatureStart',
  'git:gitflowFeatureFinish', 'git:gitflowReleaseStart', 'git:gitflowReleaseFinish', 'git:gitflowHotfixStart',
  'git:gitflowHotfixFinish', 'git:pushWithUpstream', 'git:addWorktree', 'git:removeWorktree', 'git:pruneWorktrees',
  'git:recoverToBranch', 'git:startBisect', 'git:markBisect', 'git:resetBisect', 'git:importPatch',
  'git:initializeLfs', 'git:trackLfs', 'git:setSparsePaths', 'git:disableSparse', 'git:runMaintenance',
  'git:setMaintenance', 'profiles:apply', 'automation:run'
]);

let operationQueue;

// Every IPC handler registered below receives the same sender validation.
const ipcMain = {
  handle(channel, listener) {
    return electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      if (!operationQueue || !MUTATING_GIT_CHANNELS.has(channel)) return listener(event, ...args);
      const serviceAtQueueTime = gitService;
      return operationQueue.enqueue(channel.replace(/^git:/, '').replace(/([A-Z])/g, ' $1').toLowerCase(), async signal => {
        if (gitService !== serviceAtQueueTime) throw new Error('Active repository changed before the queued operation started');
        if (serviceAtQueueTime) serviceAtQueueTime.operationSignal = signal;
        try { return await listener(event, ...args); }
        finally { if (serviceAtQueueTime) serviceAtQueueTime.operationSignal = null; }
      });
    });
  }
};

let mainWindow;
let gitService;
let fileWatcher = null;
operationQueue = new OperationQueue({
  onChange: status => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('operations:changed', status);
  }
});
const runtimeManager = new GitRuntimeManager({
  userDataPath: app.getPath('userData'),
  resourcesPath: process.resourcesPath,
  developmentRoot: path.resolve(__dirname, '../..')
});
const credentialManager = new CredentialManager({
  runtimeManager,
  userDataPath: app.getPath('userData')
});
const diagnosticsService = new DiagnosticsService({
  runtimeManager,
  credentialManager,
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged
});
const providerManager = new ProviderManager({
  userDataPath: app.getPath('userData'),
  safeStorage
});
const profileManager = new ProfileManager({ userDataPath: app.getPath('userData') });
const macroManager = new MacroManager({ userDataPath: app.getPath('userData') });

function sendAutomationEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('automations:event', event);
}

function createMacroRunner() {
  if (!gitService) throw new Error('No repository opened');
  return new MacroRunner({ gitService, onProgress: sendAutomationEvent });
}

async function runTriggeredAutomations(event, context) {
  if (!gitService) return [];
  const macros = macroManager.matching(event, context, gitService.repoPath);
  const results = [];
  for (const macro of macros) {
    try {
      results.push(await createMacroRunner().run(macro, { ...context, trigger: event }));
    } catch (error) {
      // The Git event already succeeded, so report a hook failure separately.
      sendAutomationEvent({ phase: 'hook-failed', macroId: macro.id, macroName: macro.name, trigger: event, message: error.message });
    }
  }
  return results;
}

async function createGitService(repoPath) {
  const runtime = await runtimeManager.resolve(repoPath);
  const environment = await credentialManager.getEnvironment(repoPath, runtime);
  return new GitService(repoPath, { ...runtime, environment });
}

async function reloadGitService() {
  if (!gitService) return null;
  const repoPath = gitService.repoPath;
  const nextService = await createGitService(repoPath);
  await nextService.assertRepository();
  gitService = nextService;
  return await gitService.getStatus();
}

function requireIdleOperationQueue() {
  if (operationQueue.isBusy()) throw new Error('Wait for or cancel the active Git operation before changing runtime or repository credentials');
}

// ─── Window state persistence ────────────────────────────
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const data = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const width = Number.isFinite(parsed.width) ? Math.min(Math.max(parsed.width, 900), 7680) : 1400;
    const height = Number.isFinite(parsed.height) ? Math.min(Math.max(parsed.height, 600), 4320) : 900;
    const candidate = {
      width,
      height,
      x: Number.isFinite(parsed.x) ? parsed.x : undefined,
      y: Number.isFinite(parsed.y) ? parsed.y : undefined,
      isMaximized: parsed.isMaximized === true
    };
    if (candidate.x !== undefined && candidate.y !== undefined) {
      const display = screen.getDisplayMatching({ x: candidate.x, y: candidate.y, width, height });
      const area = display.workArea;
      const visible = candidate.x < area.x + area.width - 100
        && candidate.y < area.y + area.height - 50
        && candidate.x + width > area.x + 100
        && candidate.y + height > area.y + 50;
      if (!visible) {
        candidate.x = undefined;
        candidate.y = undefined;
      }
    }
    return candidate;
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
let autoUpdater = null;

function setupAutoUpdater() {
  if (!app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
  } catch {
    autoUpdater = null;
    return;
  }

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

  autoUpdater.on('error', (error) => {
    console.warn('Automatic update check failed:', error.message);
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: isDevelopment,
      spellcheck: false
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

  mainWindow.loadFile(RENDERER_FILE).catch((error) => {
    console.error('Failed to load renderer:', error);
    app.quit();
  });

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDevelopment) {
    mainWindow.webContents.openDevTools();
  }

  // Auto-refresh on window focus
  mainWindow.on('focus', () => {
    if (gitService && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus');
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
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
        ...(isDevelopment ? [{ role: 'forceReload' }, { role: 'toggleDevTools' }] : []),
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
                message: app.isPackaged
                  ? 'Auto-updater is not configured for this build.'
                  : 'Auto-updater is available only in packaged builds.',
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

function resolveRepositoryItem(filePath) {
  if (!gitService) throw new Error('No repository opened');
  const relative = normalizeRelativePath(gitService.repoPath, filePath);
  return path.resolve(gitService.repoPath, ...relative.split('/'));
}

function spawnDetached(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openLinuxTerminal(cwd, env) {
  const candidates = [
    ['x-terminal-emulator', []],
    ['gnome-terminal', [`--working-directory=${cwd}`]],
    ['konsole', ['--workdir', cwd]],
    ['xfce4-terminal', [`--working-directory=${cwd}`]],
    ['xterm', ['-e', 'bash']]
  ];
  let lastError;
  for (const [command, args] of candidates) {
    try {
      await spawnDetached(command, args, cwd, env);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No supported terminal emulator was found: ${lastError?.message || 'unknown error'}`);
}

function quoteShellArgument(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function openInteractiveCommand(spec, env) {
  if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args) || typeof spec.cwd !== 'string') {
    throw new Error('Interactive command specification is invalid');
  }
  if ([spec.command, spec.cwd, ...spec.args].some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) {
    throw new Error('Interactive command contains invalid characters');
  }
  if (process.platform === 'win32') {
    if ([spec.command, spec.cwd, ...spec.args].some(value => value.includes('"'))) {
      throw new Error('Interactive command contains a quote that cannot be represented safely on Windows');
    }
    const interactiveEnvironment = { ...env, KITSUNE_INTERACTIVE_EXE: spec.command };
    const variables = spec.args.map((value, index) => {
      const name = `KITSUNE_INTERACTIVE_ARG_${index}`;
      interactiveEnvironment[name] = value;
      return `"%${name}%"`;
    });
    const commandLine = [`"%KITSUNE_INTERACTIVE_EXE%"`, ...variables].join(' ');
    await spawnDetached('cmd.exe', ['/D', '/S', '/K', commandLine], spec.cwd, interactiveEnvironment);
    return;
  }
  if (process.platform === 'darwin') {
    const commandDirectory = path.join(app.getPath('userData'), 'interactive');
    fs.mkdirSync(commandDirectory, { recursive: true });
    const scriptPath = path.join(commandDirectory, 'ssh-operation.command');
    const script = `#!/bin/sh\ncd ${quoteShellArgument(spec.cwd)}\n${[spec.command, ...spec.args].map(quoteShellArgument).join(' ')}\nprintf '\\nPress Return to close...'\nread answer\n`;
    fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });
    await spawnDetached('open', ['-a', 'Terminal', scriptPath], spec.cwd, env);
    return;
  }
  const candidates = [
    ['x-terminal-emulator', ['-e', spec.command, ...spec.args]],
    ['gnome-terminal', ['--', spec.command, ...spec.args]],
    ['konsole', ['-e', spec.command, ...spec.args]],
    ['xfce4-terminal', ['-e', spec.command, ...spec.args]]
  ];
  let lastError;
  for (const [terminal, args] of candidates) {
    try {
      await spawnDetached(terminal, args, spec.cwd, env);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No supported terminal emulator was found: ${lastError?.message || 'unknown error'}`);
}

// ─── IPC Handlers ────────────────────────────────────────────

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openGitExecutable', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Git executable',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Git executable', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── Git runtime ───────────────────────────────────────────

ipcMain.handle('runtime:getStatus', async (_, repoPath) => {
  return await runtimeManager.getStatus(repoPath || gitService?.repoPath);
});

ipcMain.handle('runtime:getSettings', (_, repoPath) => {
  return runtimeManager.getSettings(repoPath || gitService?.repoPath);
});

ipcMain.handle('runtime:setSettings', async (_, settings, repoPath) => {
  requireIdleOperationQueue();
  const activeRepo = repoPath || gitService?.repoPath;
  const runtime = await runtimeManager.setSettings(settings, activeRepo);
  const repositoryStatus = await reloadGitService();
  return { runtime, repositoryStatus };
});

ipcMain.handle('runtime:clearRepositoryOverride', async (_, repoPath) => {
  requireIdleOperationQueue();
  const activeRepo = repoPath || gitService?.repoPath;
  if (!activeRepo) throw new Error('No repository selected');
  runtimeManager.clearRepositoryOverride(activeRepo);
  const repositoryStatus = await reloadGitService();
  return { runtime: await runtimeManager.getStatus(activeRepo), repositoryStatus };
});

ipcMain.handle('runtime:installManaged', async () => {
  requireIdleOperationQueue();
  const runtime = await runtimeManager.installManaged(progress => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:progress', progress);
  });
  const repositoryStatus = await reloadGitService();
  return { runtime, repositoryStatus };
});

// ─── Authentication and SSH keys ───────────────────────────

ipcMain.handle('dialog:openSshKey', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an SSH private key',
    defaultPath: path.join(require('node:os').homedir(), '.ssh'),
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('auth:getStatus', async (_, repoPath) => {
  return await credentialManager.getStatus(repoPath || gitService?.repoPath);
});

ipcMain.handle('auth:configureGcm', async (_, store, repoPath) => {
  return await credentialManager.configureGcm(repoPath || gitService?.repoPath, store);
});

ipcMain.handle('auth:eraseHttpsCredential', async (_, host, repoPath) => {
  return await credentialManager.eraseHttpsCredential(repoPath || gitService?.repoPath, host);
});

ipcMain.handle('auth:importKey', async (_, keyPath) => {
  await credentialManager.importKey(keyPath);
  return await credentialManager.getStatus(gitService?.repoPath);
});

ipcMain.handle('auth:removeImportedKey', async (_, keyPath) => {
  requireIdleOperationQueue();
  credentialManager.removeImportedKey(keyPath);
  await reloadGitService();
  return await credentialManager.getStatus(gitService?.repoPath);
});

ipcMain.handle('auth:setRepositoryKey', async (_, keyPath, repoPath) => {
  requireIdleOperationQueue();
  const activeRepo = repoPath || gitService?.repoPath;
  if (!activeRepo) throw new Error('Open a repository before assigning an SSH key');
  credentialManager.setRepositoryKey(activeRepo, keyPath || null);
  await reloadGitService();
  return await credentialManager.getStatus(activeRepo);
});

ipcMain.handle('auth:generateKey', async (_, input, repoPath) => {
  const activeRepo = repoPath || gitService?.repoPath;
  const spec = await credentialManager.prepareGenerateKey(activeRepo, input);
  const runtime = await runtimeManager.resolve(activeRepo);
  await openInteractiveCommand(spec, runtime.environment);
  return true;
});

ipcMain.handle('auth:addKeyToAgent', async (_, keyPath, repoPath) => {
  const activeRepo = repoPath || gitService?.repoPath;
  const spec = await credentialManager.prepareAddToAgent(activeRepo, keyPath);
  const runtime = await runtimeManager.resolve(activeRepo);
  await openInteractiveCommand(spec, runtime.environment);
  return true;
});

ipcMain.handle('auth:removeKeyFromAgent', async (_, keyPath, repoPath) => {
  return await credentialManager.removeFromAgent(repoPath || gitService?.repoPath, keyPath);
});

ipcMain.handle('auth:readPublicKey', (_, keyPath) => {
  return credentialManager.readPublicKey(keyPath);
});

ipcMain.handle('auth:deleteKey', async (_, keyPath) => {
  requireIdleOperationQueue();
  credentialManager.deleteKey(keyPath);
  await reloadGitService();
  return await credentialManager.getStatus(gitService?.repoPath);
});

ipcMain.handle('auth:scanHost', async (_, host, port, repoPath) => {
  return await credentialManager.scanHost(repoPath || gitService?.repoPath, host, port);
});

ipcMain.handle('auth:trustHost', (_, scanResult) => {
  return credentialManager.trustHost(scanResult);
});

ipcMain.handle('auth:testSsh', async (_, host, port, user, repoPath) => {
  return await credentialManager.testSsh(repoPath || gitService?.repoPath, host, port, user);
});

// ─── Environment diagnostics ───────────────────────────────

ipcMain.handle('diagnostics:run', async (_, repoPath) => {
  return await diagnosticsService.run(repoPath || gitService?.repoPath);
});

ipcMain.handle('diagnostics:fix', async (_, id, repoPath) => {
  const report = await diagnosticsService.fix(id, repoPath || gitService?.repoPath);
  if (id === 'git-runtime') await reloadGitService();
  return report;
});

ipcMain.handle('diagnostics:export', async (_, repoPath) => {
  const report = await diagnosticsService.run(repoPath || gitService?.repoPath);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export KitsuneGIT diagnostics',
    defaultPath: `kitsunegit-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return result.filePath;
});

// ─── Git hosting providers ────────────────────────────────

ipcMain.handle('provider:status', () => providerManager.getStatus());

ipcMain.handle('provider:saveAccount', async (_, account) => {
  return await providerManager.saveAccount(account);
});

ipcMain.handle('provider:removeAccount', (_, provider) => {
  return providerManager.removeAccount(provider);
});

ipcMain.handle('provider:detectRepository', async () => {
  if (!gitService) throw new Error('No repository opened');
  return providerManager.detectRepository(await gitService.getRemotes());
});

ipcMain.handle('provider:pullRequests', async (_, repository) => {
  if (!gitService) throw new Error('No repository opened');
  return await providerManager.listPullRequests(repository);
});

ipcMain.handle('provider:createPullRequest', async (_, repository, input) => {
  if (!gitService) throw new Error('No repository opened');
  return await providerManager.createPullRequest(repository, input);
});

ipcMain.handle('profiles:list', () => profileManager.list());

ipcMain.handle('profiles:save', (_, profile) => profileManager.save(profile));

ipcMain.handle('profiles:remove', (_, name) => profileManager.remove(name));

ipcMain.handle('profiles:apply', async (_, name) => {
  if (!gitService) throw new Error('No repository opened');
  const profile = profileManager.get(name);
  const repoPath = gitService.repoPath;
  await runtimeManager.setSettings({
    mode: profile.runtimeMode,
    customPath: profile.runtimePath,
    scope: 'repository'
  }, repoPath);
  credentialManager.setRepositoryKey(repoPath, profile.sshKeyPath || null);
  await reloadGitService();
  if (profile.identityName) await gitService.setConfig('user.name', profile.identityName);
  if (profile.identityEmail) await gitService.setConfig('user.email', profile.identityEmail);
  if (profile.autocrlf) await gitService.setConfig('core.autocrlf', profile.autocrlf);
  if (profile.pullRebase) await gitService.setConfig('pull.rebase', profile.pullRebase);
  return { profile, status: await gitService.getStatus() };
});

ipcMain.handle('operations:getStatus', () => operationQueue.status());

ipcMain.handle('operations:cancel', (_, id) => operationQueue.cancel(id));

// ─── Visual Git automations ─────────────────────────────────

ipcMain.handle('automation:list', () => macroManager.list(gitService?.repoPath));

ipcMain.handle('automation:save', (_, macro) => macroManager.save(macro, gitService?.repoPath));

ipcMain.handle('automation:remove', (_, id) => macroManager.remove(id, gitService?.repoPath));

ipcMain.handle('automation:run', async (_, id, input) => {
  if (!gitService) throw new Error('No repository opened');
  const macro = macroManager.get(id, gitService.repoPath);
  if (!macro.enabled) throw new Error(`Macro is disabled: ${macro.name}`);
  return await createMacroRunner().run(macro, { ...input, trigger: 'manual' });
});

// ─── Git operations ──────────────────────────────────────────

ipcMain.handle('git:openRepo', async (_, repoPath) => {
  if (operationQueue.isBusy()) throw new Error('Wait for or cancel the active Git operation before switching repositories');
  const nextService = await createGitService(repoPath);
  await nextService.assertRepository();
  const status = await nextService.getStatus();
  gitService = nextService;
  return status;
});

ipcMain.handle('git:initRepo', async (_, repoPath) => {
  const nextService = await createGitService(repoPath);
  const status = await nextService.init();
  gitService = nextService;
  return status;
});

ipcMain.handle('git:clone', async (_, url, targetPath) => {
  const nextService = await createGitService(targetPath);
  const status = await nextService.clone(url, targetPath);
  gitService = nextService;
  return status;
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

ipcMain.handle('git:applySelection', async (_, filePath, selection, action) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.applySelection(filePath, selection, action);
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
  const status = await gitService.commit(message, amend);
  await runTriggeredAutomations('after_commit', {
    commitMessage: message,
    currentBranch: status.current,
    startBranch: status.current
  });
  return status;
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

ipcMain.handle('git:interactiveRebasePreview', async (_, upstream) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.previewInteractiveRebase(upstream);
});

ipcMain.handle('git:startInteractiveRebase', async (_, upstream, plan) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.startInteractiveRebase(upstream, plan);
});

ipcMain.handle('git:operationState', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getOperationState();
});

ipcMain.handle('git:conflictFile', async (_, filePath) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getConflictFile(filePath);
});

ipcMain.handle('git:saveConflictResolution', async (_, filePath, content) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.saveConflictResolution(filePath, content);
});

ipcMain.handle('git:resolveConflictUsing', async (_, filePath, side) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.resolveConflictUsing(filePath, side);
});

ipcMain.handle('git:continueOperation', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.continueOperation();
});

ipcMain.handle('git:abortOperation', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.abortOperation();
});

ipcMain.handle('git:worktrees', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getWorktrees();
});

ipcMain.handle('git:addWorktree', async (_, options) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.addWorktree(options);
});

ipcMain.handle('git:removeWorktree', async (_, targetPath, force) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.removeWorktree(targetPath, force);
});

ipcMain.handle('git:pruneWorktrees', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.pruneWorktrees();
});

ipcMain.handle('git:reflog', async (_, maxCount) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getReflog(maxCount);
});

ipcMain.handle('git:recoverToBranch', async (_, hash, branch) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.recoverToBranch(hash, branch);
});

ipcMain.handle('git:bisectStatus', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getBisectStatus();
});

ipcMain.handle('git:startBisect', async (_, good, bad) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.startBisect(good, bad);
});

ipcMain.handle('git:markBisect', async (_, result) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.markBisect(result);
});

ipcMain.handle('git:resetBisect', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.resetBisect();
});

ipcMain.handle('git:exportPatch', async (_, hash) => {
  if (!gitService) throw new Error('No repository opened');
  const patchContent = await gitService.createMailboxPatch(hash);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export commit patch',
    defaultPath: `${String(hash).slice(0, 12)}.patch`,
    filters: [{ name: 'Git patch', extensions: ['patch'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, patchContent, { encoding: 'utf8', mode: 0o600 });
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('git:importPatch', async () => {
  if (!gitService) throw new Error('No repository opened');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Git patch',
    properties: ['openFile'],
    filters: [{ name: 'Git patches', extensions: ['patch', 'mbox', 'eml'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const selected = result.filePaths[0];
  const stat = fs.statSync(selected);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Patch file is invalid or larger than 64 MiB');
  const content = fs.readFileSync(selected, 'utf8');
  const status = await gitService.applyMailboxPatch(content);
  return { canceled: false, path: selected, status };
});

ipcMain.handle('git:lfsStatus', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getLfsStatus();
});

ipcMain.handle('git:initializeLfs', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.initializeLfs();
});

ipcMain.handle('git:trackLfs', async (_, pattern, enabled) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.trackLfs(pattern, enabled);
});

ipcMain.handle('git:sparseStatus', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getSparseStatus();
});

ipcMain.handle('git:setSparsePaths', async (_, paths) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.setSparsePaths(paths);
});

ipcMain.handle('git:disableSparse', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.disableSparseCheckout();
});

ipcMain.handle('git:maintenanceStatus', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getMaintenanceStatus();
});

ipcMain.handle('git:repositoryOverview', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.getRepositoryOverview();
});

ipcMain.handle('git:runMaintenance', async () => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.runMaintenance();
});

ipcMain.handle('git:setMaintenance', async (_, enabled) => {
  if (!gitService) throw new Error('No repository opened');
  return await gitService.setMaintenance(enabled);
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

ipcMain.handle('shell:showItemInFolder', async (_, filePath) => {
  shell.showItemInFolder(resolveRepositoryItem(filePath));
});

ipcMain.handle('shell:openInTerminal', async (_, dirPath) => {
  if (!gitService) throw new Error('No repository opened');
  const resolved = normalizeRepositoryPath(dirPath);
  if (path.relative(gitService.repoPath, resolved) !== '') {
    throw new Error('Terminal can only be opened in the active repository');
  }
  const runtime = await runtimeManager.resolve(gitService.repoPath);
  if (process.platform === 'win32') {
    await spawnDetached('cmd.exe', ['/D', '/S', '/K', 'cd /d "%KITSUNE_TERMINAL_DIR%"'], resolved, {
      ...runtime.environment,
      KITSUNE_TERMINAL_DIR: resolved
    });
  } else if (process.platform === 'darwin') {
    await spawnDetached('open', ['-a', 'Terminal', resolved], resolved, runtime.environment);
  } else {
    await openLinuxTerminal(resolved, runtime.environment);
  }
});

ipcMain.handle('shell:openFileInEditor', async (_, filePath) => {
  const error = await shell.openPath(resolveRepositoryItem(filePath));
  if (error) throw new Error(error);
});

ipcMain.handle('shell:openExternalUrl', async (_, value) => {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('External URL is invalid');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('External URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Only credential-free HTTPS URLs can be opened');
  await shell.openExternal(parsed.href);
  return true;
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
  if (!gitService) throw new Error('No repository opened');
  const safeRepoPath = normalizeRepositoryPath(repoPath);
  if (path.relative(gitService.repoPath, safeRepoPath) !== '') {
    throw new Error('Watcher path must match the active repository');
  }
  await stopWatcher();

  if (chokidar) {
    fileWatcher = chokidar.watch(safeRepoPath, {
      ignored: (filePath) => {
        const relative = path.relative(safeRepoPath, filePath).replace(/\\/g, '/');
        if (!relative) return false;
        if (relative === 'node_modules' || relative.startsWith('node_modules/')) return true;
        if (relative === '.git') return false;
        if (relative.startsWith('.git/')) {
          const gitPath = relative.substring(5);
          return !(
            gitPath === 'HEAD'
            || gitPath === 'index'
            || gitPath === 'packed-refs'
            || gitPath.endsWith('_HEAD')
            || gitPath === 'refs'
            || gitPath.startsWith('refs/')
            || gitPath === 'rebase-apply'
            || gitPath.startsWith('rebase-apply/')
            || gitPath === 'rebase-merge'
            || gitPath.startsWith('rebase-merge/')
          );
        }
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      atomic: true
    });
    fileWatcher.on('all', (_event, filePath) => {
      const filename = path.relative(safeRepoPath, filePath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watcher:changed', filename);
      }
    });
    fileWatcher.on('error', error => console.warn('Repository watcher error:', error.message));
  } else {
    // Fallback: fs.watch is recursive only on Windows and macOS.
    const watchOptions = { persistent: true };
    if (process.platform === 'win32' || process.platform === 'darwin') watchOptions.recursive = true;
    fileWatcher = fs.watch(safeRepoPath, watchOptions, (_eventType, filename) => {
      if (!filename) return;
      const relative = filename.toString().replace(/\\/g, '/');
      if (relative === 'node_modules' || relative.startsWith('node_modules/')) return;
      if (relative.startsWith('.git/') && !/(^|\/)(HEAD|index|packed-refs|refs)(\/|$)/.test(relative)) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watcher:changed', relative);
      }
    });
  }
  return true;
});

ipcMain.handle('git:stopWatcher', async () => {
  await stopWatcher();
  return true;
});

async function stopWatcher() {
  if (fileWatcher) {
    const watcher = fileWatcher;
    fileWatcher = null;
    if (typeof watcher.close === 'function') {
      await Promise.resolve(watcher.close());
    }
  }
}

// ─── App lifecycle ───────────────────────────────────────────

app.enableSandbox();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const allowPermission = (webContents, permission) => (
      permission === 'clipboard-sanitized-write'
      && mainWindow
      && webContents === mainWindow.webContents
    );
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(allowPermission(webContents, permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return allowPermission(webContents, permission);
    });
    createWindow();
    setupAutoUpdater();
  });
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  void stopWatcher();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
