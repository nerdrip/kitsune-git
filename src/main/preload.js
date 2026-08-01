const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  // Dialogs
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openGitExecutable: () => ipcRenderer.invoke('dialog:openGitExecutable'),

  // Git runtime
  runtimeStatus: (repoPath) => ipcRenderer.invoke('runtime:getStatus', repoPath),
  runtimeSettings: (repoPath) => ipcRenderer.invoke('runtime:getSettings', repoPath),
  setRuntimeSettings: (settings, repoPath) => ipcRenderer.invoke('runtime:setSettings', settings, repoPath),
  clearRuntimeOverride: (repoPath) => ipcRenderer.invoke('runtime:clearRepositoryOverride', repoPath),
  installManagedRuntime: () => ipcRenderer.invoke('runtime:installManaged'),
  onRuntimeProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    const listener = (_, progress) => callback(progress);
    ipcRenderer.on('runtime:progress', listener);
    return () => ipcRenderer.removeListener('runtime:progress', listener);
  },

  // Authentication and SSH keys
  openSshKey: () => ipcRenderer.invoke('dialog:openSshKey'),
  authStatus: (repoPath) => ipcRenderer.invoke('auth:getStatus', repoPath),
  configureGcm: (store, repoPath) => ipcRenderer.invoke('auth:configureGcm', store, repoPath),
  eraseHttpsCredential: (host, repoPath) => ipcRenderer.invoke('auth:eraseHttpsCredential', host, repoPath),
  importSshKey: (keyPath) => ipcRenderer.invoke('auth:importKey', keyPath),
  removeImportedSshKey: (keyPath) => ipcRenderer.invoke('auth:removeImportedKey', keyPath),
  setRepositorySshKey: (keyPath, repoPath) => ipcRenderer.invoke('auth:setRepositoryKey', keyPath, repoPath),
  generateSshKey: (input, repoPath) => ipcRenderer.invoke('auth:generateKey', input, repoPath),
  addSshKeyToAgent: (keyPath, repoPath) => ipcRenderer.invoke('auth:addKeyToAgent', keyPath, repoPath),
  removeSshKeyFromAgent: (keyPath, repoPath) => ipcRenderer.invoke('auth:removeKeyFromAgent', keyPath, repoPath),
  readSshPublicKey: (keyPath) => ipcRenderer.invoke('auth:readPublicKey', keyPath),
  deleteSshKey: (keyPath) => ipcRenderer.invoke('auth:deleteKey', keyPath),
  scanSshHost: (host, port, repoPath) => ipcRenderer.invoke('auth:scanHost', host, port, repoPath),
  trustSshHost: (scanResult) => ipcRenderer.invoke('auth:trustHost', scanResult),
  testSshConnection: (host, port, user, repoPath) => ipcRenderer.invoke('auth:testSsh', host, port, user, repoPath),

  // Diagnostics
  runDiagnostics: (repoPath) => ipcRenderer.invoke('diagnostics:run', repoPath),
  fixDiagnostic: (id, repoPath) => ipcRenderer.invoke('diagnostics:fix', id, repoPath),
  exportDiagnostics: (repoPath) => ipcRenderer.invoke('diagnostics:export', repoPath),

  // Git hosting providers and encrypted access tokens
  providerStatus: () => ipcRenderer.invoke('provider:status'),
  saveProviderAccount: (account) => ipcRenderer.invoke('provider:saveAccount', account),
  removeProviderAccount: (provider) => ipcRenderer.invoke('provider:removeAccount', provider),
  detectProviderRepository: () => ipcRenderer.invoke('provider:detectRepository'),
  pullRequests: (repository) => ipcRenderer.invoke('provider:pullRequests', repository),
  createPullRequest: (repository, input) => ipcRenderer.invoke('provider:createPullRequest', repository, input),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternalUrl', url),

  // Serialized Git operation queue
  operationQueueStatus: () => ipcRenderer.invoke('operations:getStatus'),
  cancelQueuedOperation: (id) => ipcRenderer.invoke('operations:cancel', id),
  onOperationQueueChange: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    const listener = (_, status) => callback(status);
    ipcRenderer.on('operations:changed', listener);
    return () => ipcRenderer.removeListener('operations:changed', listener);
  },

  // Visual Git automations and app-level hooks
  automations: () => ipcRenderer.invoke('automation:list'),
  saveAutomation: (macro) => ipcRenderer.invoke('automation:save', macro),
  removeAutomation: (id) => ipcRenderer.invoke('automation:remove', id),
  runAutomation: (id, input) => ipcRenderer.invoke('automation:run', id, input),
  onAutomationEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    const listener = (_, event) => callback(event);
    ipcRenderer.on('automations:event', listener);
    return () => ipcRenderer.removeListener('automations:event', listener);
  },

  // Reusable repository profiles
  profiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  removeProfile: (name) => ipcRenderer.invoke('profiles:remove', name),
  applyProfile: (name) => ipcRenderer.invoke('profiles:apply', name),

  // Repository
  openRepo: (path) => ipcRenderer.invoke('git:openRepo', path),
  initRepo: (path) => ipcRenderer.invoke('git:initRepo', path),
  clone: (url, path) => ipcRenderer.invoke('git:clone', url, path),

  // Status & Log
  status: () => ipcRenderer.invoke('git:status'),
  log: (maxCount) => ipcRenderer.invoke('git:log', maxCount),

  // Diff
  diff: (file) => ipcRenderer.invoke('git:diff', file),
  diffCached: (file) => ipcRenderer.invoke('git:diffCached', file),
  applySelection: (file, selection, action) => ipcRenderer.invoke('git:applySelection', file, selection, action),

  // Staging
  stage: (files) => ipcRenderer.invoke('git:stage', files),
  unstage: (files) => ipcRenderer.invoke('git:unstage', files),
  stageAll: () => ipcRenderer.invoke('git:stageAll'),
  unstageAll: () => ipcRenderer.invoke('git:unstageAll'),

  // Commit
  commit: (message, amend) => ipcRenderer.invoke('git:commit', message, amend),

  // Push / Pull / Fetch
  push: (remote, branch, force) => ipcRenderer.invoke('git:push', remote, branch, force),
  pull: (remote, branch, rebase) => ipcRenderer.invoke('git:pull', remote, branch, rebase),
  fetch: (remote, prune) => ipcRenderer.invoke('git:fetch', remote, prune),

  // Branches
  branches: () => ipcRenderer.invoke('git:branches'),
  createBranch: (name, startPoint) => ipcRenderer.invoke('git:createBranch', name, startPoint),
  deleteBranch: (name, force) => ipcRenderer.invoke('git:deleteBranch', name, force),
  checkout: (branch) => ipcRenderer.invoke('git:checkout', branch),

  // Merge / Rebase
  merge: (branch, noFf) => ipcRenderer.invoke('git:merge', branch, noFf),
  rebase: (branch) => ipcRenderer.invoke('git:rebase', branch),
  interactiveRebasePreview: (upstream) => ipcRenderer.invoke('git:interactiveRebasePreview', upstream),
  startInteractiveRebase: (upstream, plan) => ipcRenderer.invoke('git:startInteractiveRebase', upstream, plan),
  operationState: () => ipcRenderer.invoke('git:operationState'),
  conflictFile: (file) => ipcRenderer.invoke('git:conflictFile', file),
  saveConflictResolution: (file, content) => ipcRenderer.invoke('git:saveConflictResolution', file, content),
  resolveConflictUsing: (file, side) => ipcRenderer.invoke('git:resolveConflictUsing', file, side),
  continueOperation: () => ipcRenderer.invoke('git:continueOperation'),
  abortOperation: () => ipcRenderer.invoke('git:abortOperation'),

  // Advanced repository tools
  worktrees: () => ipcRenderer.invoke('git:worktrees'),
  addWorktree: (options) => ipcRenderer.invoke('git:addWorktree', options),
  removeWorktree: (path, force) => ipcRenderer.invoke('git:removeWorktree', path, force),
  pruneWorktrees: () => ipcRenderer.invoke('git:pruneWorktrees'),
  reflog: (maxCount) => ipcRenderer.invoke('git:reflog', maxCount),
  recoverToBranch: (hash, branch) => ipcRenderer.invoke('git:recoverToBranch', hash, branch),
  bisectStatus: () => ipcRenderer.invoke('git:bisectStatus'),
  startBisect: (good, bad) => ipcRenderer.invoke('git:startBisect', good, bad),
  markBisect: (result) => ipcRenderer.invoke('git:markBisect', result),
  resetBisect: () => ipcRenderer.invoke('git:resetBisect'),
  exportPatch: (hash) => ipcRenderer.invoke('git:exportPatch', hash),
  importPatch: () => ipcRenderer.invoke('git:importPatch'),
  lfsStatus: () => ipcRenderer.invoke('git:lfsStatus'),
  initializeLfs: () => ipcRenderer.invoke('git:initializeLfs'),
  trackLfs: (pattern, enabled) => ipcRenderer.invoke('git:trackLfs', pattern, enabled),
  sparseStatus: () => ipcRenderer.invoke('git:sparseStatus'),
  setSparsePaths: (paths) => ipcRenderer.invoke('git:setSparsePaths', paths),
  disableSparse: () => ipcRenderer.invoke('git:disableSparse'),
  maintenanceStatus: () => ipcRenderer.invoke('git:maintenanceStatus'),
  repositoryOverview: () => ipcRenderer.invoke('git:repositoryOverview'),
  runMaintenance: () => ipcRenderer.invoke('git:runMaintenance'),
  setMaintenance: (enabled) => ipcRenderer.invoke('git:setMaintenance', enabled),

  // Tags
  tags: () => ipcRenderer.invoke('git:tags'),
  createTag: (name, msg, hash) => ipcRenderer.invoke('git:createTag', name, msg, hash),
  deleteTag: (name) => ipcRenderer.invoke('git:deleteTag', name),
  pushTag: (name, remote) => ipcRenderer.invoke('git:pushTag', name, remote),

  // Stash
  stash: (message, includeUntracked) => ipcRenderer.invoke('git:stash', message, includeUntracked),
  stashList: () => ipcRenderer.invoke('git:stashList'),
  stashPop: (index) => ipcRenderer.invoke('git:stashPop', index),
  stashApply: (index) => ipcRenderer.invoke('git:stashApply', index),
  stashDrop: (index) => ipcRenderer.invoke('git:stashDrop', index),

  // Remotes
  remotes: () => ipcRenderer.invoke('git:remotes'),
  addRemote: (name, url) => ipcRenderer.invoke('git:addRemote', name, url),
  removeRemote: (name) => ipcRenderer.invoke('git:removeRemote', name),

  // Advanced
  cherryPick: (hash) => ipcRenderer.invoke('git:cherryPick', hash),
  revert: (hash) => ipcRenderer.invoke('git:revert', hash),
  reset: (hash, mode) => ipcRenderer.invoke('git:reset', hash, mode),
  blame: (file) => ipcRenderer.invoke('git:blame', file),
  showCommit: (hash) => ipcRenderer.invoke('git:showCommit', hash),
  discardFile: (file) => ipcRenderer.invoke('git:discardFile', file),
  discardUntracked: (file) => ipcRenderer.invoke('git:discardUntracked', file),
  discardAll: () => ipcRenderer.invoke('git:discardAll'),
  addToGitignore: (pattern) => ipcRenderer.invoke('git:addToGitignore', pattern),
  fileHistory: (file) => ipcRenderer.invoke('git:fileHistory', file),

  // Diff Stats
  diffStats: () => ipcRenderer.invoke('git:diffStats'),
  diffStatsCached: () => ipcRenderer.invoke('git:diffStatsCached'),

  // Submodules
  submodules: () => ipcRenderer.invoke('git:submodules'),
  updateSubmodule: (path) => ipcRenderer.invoke('git:updateSubmodule', path),

  // Config
  getConfig: () => ipcRenderer.invoke('git:getConfig'),
  setConfig: (key, value) => ipcRenderer.invoke('git:setConfig', key, value),

  // Search
  searchLog: (query, max) => ipcRenderer.invoke('git:searchLog', query, max),

  // Commit files
  commitFiles: (hash) => ipcRenderer.invoke('git:commitFiles', hash),
  commitFileDiff: (hash, file) => ipcRenderer.invoke('git:commitFileDiff', hash, file),

  // Branch rename
  renameBranch: (oldName, newName) => ipcRenderer.invoke('git:renameBranch', oldName, newName),

  // Branch comparison
  branchDiff: (from, to) => ipcRenderer.invoke('git:branchDiff', from, to),

  // Last commit message
  lastCommitMessage: () => ipcRenderer.invoke('git:lastCommitMessage'),

  // GitFlow
  gitflowInit: (options) => ipcRenderer.invoke('git:gitflowInit', options),
  gitflowFeatureStart: (name) => ipcRenderer.invoke('git:gitflowFeatureStart', name),
  gitflowFeatureFinish: (name) => ipcRenderer.invoke('git:gitflowFeatureFinish', name),
  gitflowReleaseStart: (version) => ipcRenderer.invoke('git:gitflowReleaseStart', version),
  gitflowReleaseFinish: (version, tagMessage) => ipcRenderer.invoke('git:gitflowReleaseFinish', version, tagMessage),
  gitflowHotfixStart: (version) => ipcRenderer.invoke('git:gitflowHotfixStart', version),
  gitflowHotfixFinish: (version, tagMessage) => ipcRenderer.invoke('git:gitflowHotfixFinish', version, tagMessage),
  gitflowBranches: () => ipcRenderer.invoke('git:gitflowBranches'),

  // Push with upstream
  pushWithUpstream: (remote, branch) => ipcRenderer.invoke('git:pushWithUpstream', remote, branch),

  // File watcher
  startWatcher: (path) => ipcRenderer.invoke('git:startWatcher', path),
  stopWatcher: () => ipcRenderer.invoke('git:stopWatcher'),
  onWatcherChange: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    const listener = (_, filename) => callback(filename);
    ipcRenderer.on('watcher:changed', listener);
    return () => ipcRenderer.removeListener('watcher:changed', listener);
  },

  // Shell
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openInTerminal: (dirPath) => ipcRenderer.invoke('shell:openInTerminal', dirPath),
  openFileInEditor: (filePath) => ipcRenderer.invoke('shell:openFileInEditor', filePath),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Menu events
  onMenuEvent: (channel, callback) => {
    const validChannels = [
      'menu:open-repo', 'menu:clone-repo', 'menu:init-repo', 'menu:refresh',
      'menu:fetch', 'menu:pull', 'menu:push',
      'menu:create-branch', 'menu:merge', 'menu:rebase',
      'menu:stash', 'menu:stash-pop', 'menu:create-tag',
      'menu:gitflow-init', 'menu:gitflow-feature-start', 'menu:gitflow-feature-finish',
      'menu:gitflow-release-start', 'menu:gitflow-release-finish',
      'menu:gitflow-hotfix-start', 'menu:gitflow-hotfix-finish',
      'window:focus'
    ];
    if (!validChannels.includes(channel)) throw new Error('Unsupported menu event channel');
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    const listener = (_, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});

contextBridge.exposeInMainWorld('api', api);
