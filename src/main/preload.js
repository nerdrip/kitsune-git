const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Dialogs
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),

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
  rebaseAbort: () => ipcRenderer.invoke('git:rebaseAbort'),
  rebaseContinue: () => ipcRenderer.invoke('git:rebaseContinue'),

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
  gitflowConfig: () => ipcRenderer.invoke('git:gitflowConfig'),
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
    ipcRenderer.on('watcher:changed', (_, filename) => callback(filename));
  },

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openPath: (dirPath) => ipcRenderer.invoke('shell:openPath', dirPath),
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
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => callback(...args));
    }
  }
});
