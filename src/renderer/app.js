// =====================================================================
// KitsuneGIT — Renderer (app.js)
// Full-featured frontend: multi-tab, themes, drag-drop, search,
// conventional commits, side-by-side diff, settings, file watcher, etc.
// =====================================================================

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────
  const state = {
    repoPath: null,
    currentView: 'status',
    selectedFile: null,
    selectedCommit: null,
    selectedFiles: new Set(),    // multi-select for staging
    lastClickedFile: null,       // for shift-click range
    status: null,
    log: [],
    branches: null,
    tags: [],
    stashes: [],
    remotes: [],
    submodules: [],
    diffStats: [],
    diffStatsCached: [],
    diffMode: 'inline', // 'inline' | 'side'
    lastDiffText: '',
    lastDiffFile: null,
    lastDiffCached: false,
    lastCommitDiffText: '',
    tabs: [],       // [{path, name}]
    activeTabIdx: -1,
    watcherDebounce: null,
    isRebaseInProgress: false,
    gitflow: null,  // {config, features, releases, hotfixes, current}
    autoFetchInterval: null,
    autoFetchMinutes: parseInt(localStorage.getItem('kitsune_autofetch') || '0', 10) // 0 = disabled
  };

  // ─── DOM refs ─────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const welcomeScreen = $('#welcome-screen');
  const appEl = $('#app');

  // ─── Session Tabs (localStorage) ──────────────────────────
  const TABS_KEY = 'kitsune_open_tabs';
  function saveTabSession() {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      tabs: state.tabs,
      activeIdx: state.activeTabIdx
    }));
  }
  function loadTabSession() {
    try {
      const data = JSON.parse(localStorage.getItem(TABS_KEY));
      if (data && Array.isArray(data.tabs) && data.tabs.length > 0) return data;
    } catch { /* noop */ }
    return null;
  }

  // ─── Recent Repos (localStorage) ─────────────────────────
  const RECENT_KEY = 'kitsune_recent_repos';
  function getRecentRepos() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
  }
  function addRecentRepo(repoPath) {
    let recent = getRecentRepos().filter(r => r !== repoPath);
    recent.unshift(repoPath);
    if (recent.length > 10) recent = recent.slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    renderRecentRepos();
  }
  function removeRecentRepo(repoPath) {
    const recent = getRecentRepos().filter(r => r !== repoPath);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    renderRecentRepos();
  }
  function renderRecentRepos() {
    const list = $('#recent-repos-list');
    const repos = getRecentRepos();
    if (repos.length === 0) {
      $('#recent-repos').style.display = 'none';
      return;
    }
    $('#recent-repos').style.display = '';
    list.innerHTML = '';
    repos.forEach(rp => {
      const name = rp.split(/[\\/]/).pop();
      const el = document.createElement('div');
      el.className = 'recent-item';
      el.innerHTML = `
        <span class="recent-item-icon">📁</span>
        <span class="recent-item-path"><span class="recent-item-name">${escapeHtml(name)}</span><br>${escapeHtml(rp)}</span>
        <button class="recent-item-remove" title="Remove">✕</button>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.recent-item-remove')) return;
        openRepoPath(rp);
      });
      el.querySelector('.recent-item-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeRecentRepo(rp);
      });
      list.appendChild(el);
    });
  }
  renderRecentRepos();

  // ─── Theme ────────────────────────────────────────────────
  const THEME_KEY = 'kitsune_theme';
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeBtn(saved);
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
    updateThemeBtn(next);
  }
  function updateThemeBtn(theme) {
    const btn = $('#tb-theme');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '🌙';
  }
  initTheme();

  // ─── Version in status bar ────────────────────────────────
  (async () => {
    try {
      const version = await window.api.getVersion();
      const el = $('#statusbar-version');
      if (el) el.textContent = `v${version}`;
    } catch { /* ignore */ }
  })();

  // ─── Loading Overlay ─────────────────────────────────────
  function showLoading(text) {
    $('#loading-text').textContent = text || 'Loading...';
    $('#loading-overlay').classList.remove('hidden');
  }
  function hideLoading() {
    $('#loading-overlay').classList.add('hidden');
  }

  // ─── Toast ────────────────────────────────────────────────
  function toast(message, type = 'info') {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-text">${escapeHtml(message)}</span><button class="toast-close" title="Dismiss">✕</button>`;
    el.querySelector('.toast-close').addEventListener('click', () => el.remove());
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-fade-out');
      el.addEventListener('animationend', () => el.remove());
    }, 5000);
  }

  function setStatus(text) {
    $('#statusbar-text').textContent = text;
  }

  // ─── Modal ────────────────────────────────────────────────
  let _modalEnterHandler = null;
  function showModal(title, bodyHTML, buttons = []) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHTML;
    const footer = $('#modal-footer');
    footer.innerHTML = '';
    const primaryBtn = buttons.find(b => b.primary);
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className = `btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}`;
      btn.textContent = b.label;
      btn.onclick = () => { b.onClick(); hideModal(); };
      footer.appendChild(btn);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = hideModal;
    footer.appendChild(cancelBtn);
    $('#modal-overlay').classList.remove('hidden');
    // Auto-focus the first input field
    const firstInput = $('#modal-body').querySelector('input, select, textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
    // Enter key submits the primary button
    if (_modalEnterHandler) document.removeEventListener('keydown', _modalEnterHandler);
    if (primaryBtn) {
      _modalEnterHandler = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && document.activeElement?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          primaryBtn.onClick();
          hideModal();
        }
      };
      document.addEventListener('keydown', _modalEnterHandler);
    } else {
      _modalEnterHandler = null;
    }
  }

  function hideModal() {
    $('#modal-overlay').classList.add('hidden');
    if (_modalEnterHandler) {
      document.removeEventListener('keydown', _modalEnterHandler);
      _modalEnterHandler = null;
    }
  }

  // ─── Shortcuts panel ─────────────────────────────────────
  function showShortcuts() { $('#shortcuts-overlay').classList.remove('hidden'); }
  function hideShortcuts() { $('#shortcuts-overlay').classList.add('hidden'); }
  $('#shortcuts-close').addEventListener('click', hideShortcuts);
  $('#shortcuts-overlay').addEventListener('click', (e) => {
    if (e.target === $('#shortcuts-overlay')) hideShortcuts();
  });

  // ─── Context Menu ────────────────────────────────────────
  let activeContextMenu = null;
  function showContextMenu(x, y, items) {
    removeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    items.forEach(item => {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        menu.appendChild(sep);
        return;
      }
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      el.textContent = item.label;
      el.onclick = () => { removeContextMenu(); item.onClick(); };
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    activeContextMenu = menu;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  }
  function removeContextMenu() {
    if (activeContextMenu) { activeContextMenu.remove(); activeContextMenu = null; }
  }
  document.addEventListener('click', removeContextMenu);

  // ─── Switch view ──────────────────────────────────────────
  function switchView(viewName) {
    state.currentView = viewName;
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${viewName}`).classList.add('active');
    $$('.sidebar-item[data-view]').forEach(el => {
      el.classList.toggle('active', el.dataset.view === viewName);
    });
    if (viewName === 'history' && state.log.length === 0) loadLog();
  }

  // ─── Sidebar collapse ────────────────────────────────────
  const SIDEBAR_STATE_KEY = 'kitsune_sidebar_collapsed';
  function loadSidebarState() {
    try { return JSON.parse(localStorage.getItem(SIDEBAR_STATE_KEY)) || {}; } catch { return {}; }
  }
  function saveSidebarState() {
    const state = {};
    $$('.sidebar-header[data-toggle]').forEach(header => {
      state[header.dataset.toggle] = header.classList.contains('collapsed');
    });
    localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(state));
  }
  (function restoreSidebarState() {
    const saved = loadSidebarState();
    $$('.sidebar-header[data-toggle]').forEach(header => {
      if (saved[header.dataset.toggle]) header.classList.add('collapsed');
    });
  })();
  $$('.sidebar-header[data-toggle]').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
      saveSidebarState();
    });
  });

  // ─── Sidebar resize ──────────────────────────────────────
  (function initSidebarResize() {
    const handle = $('#sidebar-resize');
    const sidebar = $('#sidebar');
    let startX, startWidth;
    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e) {
      sidebar.style.width = Math.max(180, Math.min(400, startWidth + (e.clientX - startX))) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  })();

  // ─── Staging area resize ─────────────────────────────────
  (function initStagingResize() {
    const handle = $('#staging-resize');
    const staging = handle?.closest('.staging-area');
    if (!handle || !staging) return;
    let startX, startWidth;
    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startWidth = staging.offsetWidth;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e) {
      staging.style.width = Math.max(260, Math.min(600, startWidth + (e.clientX - startX))) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  })();

  // ─── Navigation ───────────────────────────────────────────
  $('#nav-status').addEventListener('click', () => switchView('status'));
  $('#nav-history').addEventListener('click', () => switchView('history'));

  // ─── Welcome buttons ─────────────────────────────────────
  $('#btn-open-repo').addEventListener('click', openRepo);
  $('#btn-clone-repo').addEventListener('click', showCloneDialog);
  $('#btn-init-repo').addEventListener('click', showInitDialog);

  // ─── Toolbar buttons ─────────────────────────────────────
  $('#tb-open').addEventListener('click', openRepo);
  $('#tb-fetch').addEventListener('click', doFetch);
  $('#tb-pull').addEventListener('click', showPullDialog);
  $('#tb-push').addEventListener('click', showPushDialog);
  $('#tb-branch').addEventListener('click', showCreateBranchDialog);
  $('#tb-merge').addEventListener('click', showMergeDialog);
  $('#tb-stash').addEventListener('click', doStash);
  $('#tb-tag').addEventListener('click', showCreateTagDialog);
  $('#tb-compare').addEventListener('click', showBranchCompareDialog);
  $('#tb-gitflow').addEventListener('click', (e) => { e.stopPropagation(); showGitFlowMenu(); });
  $('#tb-terminal').addEventListener('click', () => {
    if (state.repoPath) window.api.openInTerminal(state.repoPath);
    else toast('No repository opened', 'error');
  });
  $('#tb-settings').addEventListener('click', showSettingsDialog);
  $('#tb-refresh').addEventListener('click', refresh);
  $('#tb-theme').addEventListener('click', toggleTheme);
  $('#tb-shortcuts').addEventListener('click', showShortcuts);
  $('#tab-add').addEventListener('click', openRepo);

  // ─── Staging buttons ─────────────────────────────────────
  $('#btn-stage-all').addEventListener('click', stageAll);
  $('#btn-unstage-all').addEventListener('click', unstageAll);
  $('#btn-commit').addEventListener('click', doCommit);
  $('#btn-discard-all').addEventListener('click', async () => {
    if (!state.status) return;
    const count = (state.status.modified?.length || 0) + (state.status.not_added?.length || 0) +
                  (state.status.deleted?.length || 0) + (state.status.created?.length || 0);
    if (count === 0) return toast('No changes to discard', 'info');
    if (!confirm(`Discard ALL ${count} unstaged changes? This cannot be undone!`)) return;
    try {
      showLoading('Discarding all changes...');
      await window.api.discardAll();
      await refresh();
      toast('All changes discarded', 'info');
    } catch (err) { toast('Discard failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });

  // ─── Modal close ──────────────────────────────────────────
  $('#modal-close').addEventListener('click', hideModal);
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) hideModal();
  });

  // ─── Diff mode toggle ─────────────────────────────────────
  $('#btn-copy-diff').addEventListener('click', () => {
    if (!state.lastDiffText || !state.lastDiffText.trim()) return toast('No diff to copy', 'info');
    navigator.clipboard.writeText(state.lastDiffText).then(() => toast('Diff copied to clipboard', 'info')).catch(() => toast('Failed to copy', 'error'));
  });
  $('#btn-diff-inline').addEventListener('click', () => {
    state.diffMode = 'inline';
    $('#btn-diff-inline').classList.add('btn-active');
    $('#btn-diff-side').classList.remove('btn-active');
    if (state.lastDiffText) renderDiff(state.lastDiffText);
  });
  $('#btn-diff-side').addEventListener('click', () => {
    state.diffMode = 'side';
    $('#btn-diff-side').classList.add('btn-active');
    $('#btn-diff-inline').classList.remove('btn-active');
    if (state.lastDiffText) renderDiff(state.lastDiffText);
  });

  // ─── Commit message char count & conventional commits ─────
  const commitMsg = $('#commit-message');
  const commitType = $('#commit-type');
  const commitScope = $('#commit-scope');
  const charCount = $('#commit-char-count');

  commitMsg.addEventListener('input', updateCharCount);
  function updateCharCount() {
    const text = commitMsg.value;
    const firstLine = text.split('\n')[0];
    const len = firstLine.length;
    charCount.textContent = len;
    charCount.title = 'First line length (subject line)';
    charCount.className = 'commit-char-count' + (len > 72 ? ' over' : len > 50 ? ' warn' : '');
  }

  // Ctrl+Enter to commit
  commitMsg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(); }
  });

  // ─── Commit Message History ──────────────────────────────
  const COMMIT_HISTORY_KEY = 'kitsune_commit_history';
  function getCommitHistory() {
    try { return JSON.parse(localStorage.getItem(COMMIT_HISTORY_KEY)) || []; } catch { return []; }
  }
  function addCommitHistory(msg) {
    if (!msg) return;
    let history = getCommitHistory().filter(m => m !== msg);
    history.unshift(msg);
    if (history.length > 20) history = history.slice(0, 20);
    localStorage.setItem(COMMIT_HISTORY_KEY, JSON.stringify(history));
  }
  $('#btn-commit-history').addEventListener('click', (e) => {
    e.stopPropagation();
    const history = getCommitHistory();
    if (history.length === 0) return toast('No commit history yet', 'info');
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const items = history.map(msg => ({
      label: msg.length > 60 ? msg.substring(0, 57) + '...' : msg,
      onClick: () => { commitMsg.value = msg; updateCharCount(); }
    }));
    showContextMenu(rect.left, rect.bottom + 4, items);
  });

  // ─── File search filter ──────────────────────────────────
  const fileSearchInput = $('#file-search');
  fileSearchInput.addEventListener('input', () => {
    const q = fileSearchInput.value.toLowerCase();
    $$('#unstaged-files .file-item, #staged-files .file-item').forEach(el => {
      const path = (el.dataset.path || '').toLowerCase();
      el.style.display = path.includes(q) ? '' : 'none';
    });
  });

  // ─── Branch search filter ────────────────────────────────
  const branchFilterInput = $('#branch-filter');
  branchFilterInput.addEventListener('input', () => {
    const q = branchFilterInput.value.toLowerCase();
    $$('#branches-list .tree-item').forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(q) ? '' : 'none';
    });
  });

  // ─── Tag search filter ──────────────────────────────────
  const tagFilterInput = $('#tag-filter');
  tagFilterInput.addEventListener('input', () => {
    const q = tagFilterInput.value.toLowerCase();
    $$('#tags-list .tree-item').forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(q) ? '' : 'none';
    });
  });

  // ─── History search ──────────────────────────────────────
  $('#history-search-btn').addEventListener('click', doHistorySearch);
  $('#history-search-clear').addEventListener('click', () => {
    $('#history-search').value = '';
    loadLog();
  });
  $('#history-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doHistorySearch();
  });

  async function doHistorySearch() {
    const q = $('#history-search').value.trim();
    if (!q) return loadLog();
    try {
      setStatus('Searching...');
      // Try grep search first, then fall back to client-side filter
      const results = await window.api.searchLog(q);
      if (results.length > 0) {
        state.log = results;
      } else {
        // Client-side filter by author/sha
        const allLog = await window.api.log(500);
        state.log = allLog.filter(c =>
          c.message.toLowerCase().includes(q.toLowerCase()) ||
          c.author.toLowerCase().includes(q.toLowerCase()) ||
          c.hash.startsWith(q.toLowerCase())
        );
      }
      renderCommitList();
      setStatus(`Found ${state.log.length} commits`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ─── Menu events ──────────────────────────────────────────
  const menuMap = {
    'menu:open-repo': openRepo,
    'menu:clone-repo': showCloneDialog,
    'menu:init-repo': showInitDialog,
    'menu:refresh': refresh,
    'menu:fetch': doFetch,
    'menu:pull': showPullDialog,
    'menu:push': showPushDialog,
    'menu:create-branch': showCreateBranchDialog,
    'menu:merge': showMergeDialog,
    'menu:rebase': showRebaseDialog,
    'menu:stash': doStash,
    'menu:stash-pop': doStashPop,
    'menu:create-tag': showCreateTagDialog,
    'menu:gitflow-init': showGitFlowInitDialog,
    'menu:gitflow-feature-start': showGitFlowFeatureStartDialog,
    'menu:gitflow-feature-finish': showGitFlowFeatureFinishDialog,
    'menu:gitflow-release-start': showGitFlowReleaseStartDialog,
    'menu:gitflow-release-finish': showGitFlowReleaseFinishDialog,
    'menu:gitflow-hotfix-start': showGitFlowHotfixStartDialog,
    'menu:gitflow-hotfix-finish': showGitFlowHotfixFinishDialog
  };
  Object.entries(menuMap).forEach(([ch, fn]) => window.api.onMenuEvent(ch, fn));

  // ─── Auto-refresh on window focus ────────────────────────
  window.api.onMenuEvent('window:focus', () => {
    if (state.repoPath) refresh();
  });

  // ─── File Watcher ────────────────────────────────────────
  window.api.onWatcherChange(() => {
    clearTimeout(state.watcherDebounce);
    // Show notification dot immediately
    const watcherDot = $('#statusbar-watcher-dot');
    if (watcherDot) watcherDot.classList.add('active');
    state.watcherDebounce = setTimeout(async () => {
      if (state.repoPath) await refresh();
      if (watcherDot) watcherDot.classList.remove('active');
    }, 1500);
  });

  // ─── Auto-fetch Timer ────────────────────────────────────
  function startAutoFetch() {
    stopAutoFetch();
    if (state.autoFetchMinutes > 0) {
      state.autoFetchInterval = setInterval(async () => {
        if (!state.repoPath) return;
        try {
          await window.api.fetch(null, true);
          const status = await window.api.status();
          const behind = status.behind || 0;
          if (behind > 0) toast(`Auto-fetch: ${behind} new commit${behind > 1 ? 's' : ''} behind remote`, 'info');
          await refresh();
        } catch { /* silent */ }
      }, state.autoFetchMinutes * 60 * 1000);
    }
  }
  function stopAutoFetch() {
    if (state.autoFetchInterval) { clearInterval(state.autoFetchInterval); state.autoFetchInterval = null; }
  }
  function setAutoFetch(minutes) {
    state.autoFetchMinutes = minutes;
    localStorage.setItem('kitsune_autofetch', String(minutes));
    startAutoFetch();
  }
  // Start auto-fetch if enabled
  startAutoFetch();

  // ═════════════════════════════════════════════════════════
  //  MULTI-TAB REPO MANAGEMENT
  // ═════════════════════════════════════════════════════════

  function renderTabs() {
    const bar = $('#tab-bar');
    bar.querySelectorAll('.repo-tab').forEach(t => t.remove());
    const addBtn = $('#tab-add');
    state.tabs.forEach((tab, idx) => {
      const el = document.createElement('div');
      el.className = 'repo-tab' + (idx === state.activeTabIdx ? ' active' : '');
      el.innerHTML = `<span>${escapeHtml(tab.name)}</span><button class="repo-tab-close" title="Close tab">✕</button>`;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.repo-tab-close')) return;
        switchTab(idx);
      });
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(idx); }
      });
      el.querySelector('.repo-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(idx);
      });
      bar.insertBefore(el, addBtn);
    });
  }

  function addTab(repoPath) {
    const name = repoPath.split(/[\\/]/).pop();
    // Check if already open
    const existIdx = state.tabs.findIndex(t => t.path === repoPath);
    if (existIdx >= 0) {
      switchTab(existIdx);
      return;
    }
    state.tabs.push({ path: repoPath, name });
    state.activeTabIdx = state.tabs.length - 1;
    renderTabs();
    saveTabSession();
  }

  async function switchTab(idx) {
    if (idx === state.activeTabIdx) return;
    state.activeTabIdx = idx;
    const tab = state.tabs[idx];
    renderTabs();
    try {
      showLoading('Switching repository...');
      await window.api.openRepo(tab.path);
      state.repoPath = tab.path;
      await refresh();
      await window.api.startWatcher(tab.path);
    } catch (err) {
      toast('Failed to switch: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
    saveTabSession();
  }

  function closeTab(idx) {
    state.tabs.splice(idx, 1);
    if (state.tabs.length === 0) {
      state.activeTabIdx = -1;
      state.repoPath = null;
      window.api.stopWatcher();
      appEl.classList.add('hidden');
      welcomeScreen.classList.remove('hidden');
    } else {
      if (state.activeTabIdx >= state.tabs.length) state.activeTabIdx = state.tabs.length - 1;
      switchTab(state.activeTabIdx);
    }
    renderTabs();
    saveTabSession();
  }

  // ═════════════════════════════════════════════════════════
  //  REPO OPERATIONS
  // ═════════════════════════════════════════════════════════

  async function openRepo() {
    const dir = await window.api.openDirectory();
    if (!dir) return;
    await openRepoPath(dir);
  }

  async function openRepoPath(dir) {
    try {
      showLoading('Opening repository...');
      setStatus('Opening repository...');
      const status = await window.api.openRepo(dir);
      state.repoPath = dir;
      state.status = status;
      addRecentRepo(dir);
      addTab(dir);
      enterApp();
      await window.api.startWatcher(dir);
      await refresh();
      toast('Repository opened', 'success');
    } catch (err) {
      toast('Failed to open repository: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  }

  function showCloneDialog() {
    showModal('Clone Repository', `
      <div class="form-group">
        <label>Repository URL</label>
        <input id="clone-url" type="text" placeholder="https://github.com/user/repo.git">
      </div>
      <div class="form-group">
        <label>Target Directory</label>
        <div style="display:flex;gap:8px">
          <input id="clone-path" type="text" placeholder="Select directory..." readonly style="flex:1">
          <button id="clone-browse" class="btn">Browse</button>
        </div>
      </div>
    `, [{
      label: 'Clone', primary: true, onClick: async () => {
        const url = document.getElementById('clone-url').value.trim();
        const targetPath = document.getElementById('clone-path').value.trim();
        if (!url || !targetPath) return toast('URL and path are required', 'error');
        try {
          showLoading('Cloning repository...');
          await window.api.clone(url, targetPath);
          state.repoPath = targetPath;
          addRecentRepo(targetPath);
          addTab(targetPath);
          enterApp();
          await window.api.startWatcher(targetPath);
          await refresh();
          toast('Repository cloned', 'success');
        } catch (err) {
          toast('Clone failed: ' + err.message, 'error');
        } finally { hideLoading(); }
      }
    }]);
    setTimeout(() => {
      const b = document.getElementById('clone-browse');
      if (b) b.addEventListener('click', async () => {
        const dir = await window.api.openDirectory();
        if (dir) document.getElementById('clone-path').value = dir;
      });
    });
  }

  function showInitDialog() {
    showModal('Init New Repository', `
      <div class="form-group">
        <label>Directory</label>
        <div style="display:flex;gap:8px">
          <input id="init-path" type="text" placeholder="Select directory..." readonly style="flex:1">
          <button id="init-browse" class="btn">Browse</button>
        </div>
      </div>
    `, [{
      label: 'Init', primary: true, onClick: async () => {
        const dir = document.getElementById('init-path').value.trim();
        if (!dir) return toast('Please select a directory', 'error');
        try {
          showLoading('Initializing repository...');
          await window.api.initRepo(dir);
          state.repoPath = dir;
          addRecentRepo(dir);
          addTab(dir);
          enterApp();
          await window.api.startWatcher(dir);
          await refresh();
          toast('Repository initialized', 'success');
        } catch (err) {
          toast('Init failed: ' + err.message, 'error');
        } finally { hideLoading(); }
      }
    }]);
    setTimeout(() => {
      const b = document.getElementById('init-browse');
      if (b) b.addEventListener('click', async () => {
        const dir = await window.api.openDirectory();
        if (dir) document.getElementById('init-path').value = dir;
      });
    });
  }

  function enterApp() {
    welcomeScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
  }

  // ═════════════════════════════════════════════════════════
  //  SETTINGS DIALOG
  // ═════════════════════════════════════════════════════════

  async function showSettingsDialog() {
    let config = {};
    try { config = await window.api.getConfig(); } catch { /* empty config */ }

    const fields = [
      { key: 'user.name', label: 'User Name' },
      { key: 'user.email', label: 'User Email' },
      { key: 'core.autocrlf', label: 'Auto CRLF' },
      { key: 'pull.rebase', label: 'Pull Rebase' },
      { key: 'push.default', label: 'Push Default' }
    ];

    const html = fields.map(f => `
      <div class="form-group">
        <label>${f.label} <span style="color:var(--text-muted)">(${f.key})</span></label>
        <input id="cfg-${f.key.replace('.', '-')}" type="text" value="${escapeHtml(config[f.key] || '')}">
      </div>
    `).join('') + `
      <div class="form-group">
        <label>Auto-fetch interval <span style="color:var(--text-muted)">(minutes, 0 = disabled)</span></label>
        <select id="cfg-autofetch">
          <option value="0" ${state.autoFetchMinutes === 0 ? 'selected' : ''}>Disabled</option>
          <option value="1" ${state.autoFetchMinutes === 1 ? 'selected' : ''}>Every 1 min</option>
          <option value="3" ${state.autoFetchMinutes === 3 ? 'selected' : ''}>Every 3 min</option>
          <option value="5" ${state.autoFetchMinutes === 5 ? 'selected' : ''}>Every 5 min</option>
          <option value="10" ${state.autoFetchMinutes === 10 ? 'selected' : ''}>Every 10 min</option>
          <option value="15" ${state.autoFetchMinutes === 15 ? 'selected' : ''}>Every 15 min</option>
        </select>
      </div>
    `;

    showModal('Repository Settings', html, [{
      label: 'Save', primary: true, onClick: async () => {
        try {
          for (const f of fields) {
            const input = document.getElementById(`cfg-${f.key.replace('.', '-')}`);
            const val = input.value.trim();
            if (val && val !== (config[f.key] || '')) {
              await window.api.setConfig(f.key, val);
            }
          }
          const afVal = parseInt(document.getElementById('cfg-autofetch').value, 10) || 0;
          setAutoFetch(afVal);
          toast('Settings saved', 'success');
        } catch (err) { toast(err.message, 'error'); }
      }
    }]);
  }

  // ═════════════════════════════════════════════════════════
  //  REFRESH / LOAD DATA
  // ═════════════════════════════════════════════════════════

  async function refresh() {
    if (!state.repoPath) return;
    try {
      setStatus('Refreshing...');
      const [status, branches, tags, stashes, remotes, submodules, diffStats, diffStatsCached, gitflow] = await Promise.all([
        window.api.status(),
        window.api.branches(),
        window.api.tags(),
        window.api.stashList().catch(() => []),
        window.api.remotes().catch(() => []),
        window.api.submodules().catch(() => []),
        window.api.diffStats().catch(() => []),
        window.api.diffStatsCached().catch(() => []),
        window.api.gitflowBranches().catch(() => null)
      ]);
      state.status = status;
      state.branches = branches;
      state.tags = tags;
      state.stashes = stashes;
      state.remotes = remotes;
      state.submodules = submodules;
      state.diffStats = diffStats;
      state.diffStatsCached = diffStatsCached;
      state.gitflow = gitflow;

      // Detect rebase in progress
      const hasConflicts = (state.status.conflicted?.length || 0) > 0;
      state.isRebaseInProgress = hasConflicts;
      const rebaseBar = $('#rebase-conflict-bar');
      if (rebaseBar) rebaseBar.style.display = hasConflicts ? 'flex' : 'none';

      renderStatusBar();
      renderToolbar();
      renderSidebar();
      renderFileStatus();

      if (state.currentView === 'history') await loadLog();
      setStatus('Ready');
    } catch (err) {
      setStatus('Error: ' + err.message);
      toast('Refresh failed: ' + err.message, 'error');
    }
  }

  async function loadLog() {
    try {
      state.log = await window.api.log(500);
      renderCommitList();
    } catch (err) {
      toast('Failed to load log: ' + err.message, 'error');
    }
  }

  // ═════════════════════════════════════════════════════════
  //  RENDER FUNCTIONS
  // ═════════════════════════════════════════════════════════

  function renderToolbar() {
    if (!state.status) return;
    $('#tb-branch-name').textContent = state.status.current || 'detached';
    $('#tb-repo-path').textContent = state.status.repoPath || '';
    // Ahead/behind badges on push/pull buttons
    const ahead = state.status.ahead || 0;
    const behind = state.status.behind || 0;
    const pushBtn = $('#tb-push');
    const pullBtn = $('#tb-pull');
    pushBtn.innerHTML = behind > 0 || ahead > 0
      ? `⬆ Push${ahead > 0 ? ' <span class="toolbar-badge">↑' + ahead + '</span>' : ''}`
      : '⬆ Push';
    pullBtn.innerHTML = behind > 0 || ahead > 0
      ? `⬇ Pull${behind > 0 ? ' <span class="toolbar-badge">↓' + behind + '</span>' : ''}`
      : '⬇ Pull';

    // Update window title with repo name and change count
    const repoName = state.repoPath ? state.repoPath.split(/[\\/]/).pop() : '';
    const totalChanges = (state.status.modified?.length || 0) + (state.status.not_added?.length || 0) +
      (state.status.deleted?.length || 0) + (state.status.staged?.length || 0) +
      (state.status.created?.length || 0) + (state.status.conflicted?.length || 0);
    document.title = repoName
      ? `KitsuneGIT — ${repoName}${totalChanges > 0 ? ` (${totalChanges})` : ''}`
      : 'KitsuneGIT';
  }

  function renderStatusBar() {
    if (!state.status) return;
    $('#statusbar-branch').textContent = `Branch: ${state.status.current || 'detached'}`;
    const ahead = state.status.ahead || 0;
    const behind = state.status.behind || 0;
    let syncText = '';
    if (ahead > 0) syncText += `↑${ahead} `;
    if (behind > 0) syncText += `↓${behind}`;
    $('#statusbar-sync').textContent = syncText.trim();
  }

  function renderSidebar() {
    renderBranches();
    renderTags();
    renderStashes();
    renderGitFlow();
    renderSubmodules();
    renderRemotes();
    updateBadge();
  }

  function updateBadge() {
    if (!state.status) return;
    const count = (state.status.modified?.length || 0) +
      (state.status.not_added?.length || 0) +
      (state.status.deleted?.length || 0) +
      (state.status.staged?.length || 0) +
      (state.status.created?.length || 0) +
      (state.status.conflicted?.length || 0);
    const badge = $('#badge-changes');
    badge.textContent = count;
    badge.classList.toggle('empty', count === 0);
  }

  function renderBranches() {
    const list = $('#branches-list');
    list.innerHTML = '';
    if (!state.branches) return;
    state.branches.local.forEach(name => {
      const el = createTreeItem(
        name === state.branches.current ? '●' : '○', name,
        name === state.branches.current ? 'current-branch' : ''
      );
      el.addEventListener('click', () => checkoutBranch(name));
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (name === state.branches.current) return; // Don't rename current branch inline
        const nameSpan = el.querySelector('span:last-child');
        const oldName = name;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'branch-rename-input';
        input.value = oldName;
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        const finishRename = async () => {
          const newName = input.value.trim();
          if (newName && newName !== oldName) {
            try {
              await window.api.renameBranch(oldName, newName);
              toast(`Branch renamed: ${oldName} → ${newName}`, 'success');
              await refresh();
            } catch (err) { toast(err.message, 'error'); }
          }
          renderBranches();
        };
        input.addEventListener('blur', finishRename);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
          if (ev.key === 'Escape') { renderBranches(); }
        });
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Checkout', onClick: () => checkoutBranch(name) },
          { label: 'Merge into current', onClick: () => doMerge(name) },
          { label: 'Rebase onto current', onClick: () => doRebase(name) },
          { label: 'Compare with current...', onClick: () => showBranchDiff(state.branches.current, name) },
          { separator: true },
          { label: 'Delete Branch', onClick: () => deleteBranch(name) }
        ]);
      });
      list.appendChild(el);
    });
    if (state.branches.remote.length > 0) {
      state.branches.remote.forEach(name => {
        const el = createTreeItem('☁', name, '');
        el.addEventListener('click', () => checkoutBranch(name));
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const localName = name.replace(/^[^/]+\//, '');
          showContextMenu(e.clientX, e.clientY, [
            { label: 'Checkout', onClick: () => checkoutBranch(name) },
            { label: `Create local branch "${localName}"`, onClick: () => showCreateBranchDialog(name) },
            { label: 'Compare with current...', onClick: () => showBranchDiff(state.branches.current, name) },
          ]);
        });
        list.appendChild(el);
      });
    }
  }

  function renderTags() {
    const list = $('#tags-list');
    list.innerHTML = '';
    if (state.tags.length === 0) {
      list.innerHTML = '<div class="sidebar-empty">No tags</div>';
      return;
    }
    state.tags.forEach(name => {
      const el = createTreeItem('🏷', name, '');
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Checkout Tag', onClick: () => checkoutBranch(name) },
          { label: 'Push to Remote', onClick: () => doPushTag(name) },
          { separator: true },
          { label: 'Delete Tag', onClick: () => doDeleteTag(name) }
        ]);
      });
      list.appendChild(el);
    });
  }

  function renderStashes() {
    const list = $('#stashes-list');
    list.innerHTML = '';
    if (state.stashes.length === 0) {
      list.innerHTML = '<div class="sidebar-empty">No stashes</div>';
      return;
    }
    state.stashes.forEach(s => {
      const el = createTreeItem('📦', s.message || `stash@{${s.index}}`, '');
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Apply Stash', onClick: () => doStashApplyIndex(s.index) },
          { label: 'Pop Stash', onClick: () => doStashPopIndex(s.index) },
          { separator: true },
          { label: 'Drop Stash', onClick: () => doStashDrop(s.index) }
        ]);
      });
      let stashClickTimer = null;
      el.addEventListener('click', () => {
        clearTimeout(stashClickTimer);
        stashClickTimer = setTimeout(() => doStashApplyIndex(s.index), 250);
      });
      el.addEventListener('dblclick', () => {
        clearTimeout(stashClickTimer);
        doStashPopIndex(s.index);
      });
      list.appendChild(el);
    });
  }

  function renderSubmodules() {
    const list = $('#submodules-list');
    list.innerHTML = '';
    if (state.submodules.length === 0) {
      list.innerHTML = '<div class="sidebar-empty">No submodules</div>';
      return;
    }
    state.submodules.forEach(s => {
      const el = createTreeItem('📦', s.path, '');
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Update Submodule', onClick: () => doUpdateSubmodule(s.path) }
        ]);
      });
      list.appendChild(el);
    });
  }

  function renderRemotes() {
    const list = $('#remotes-list');
    list.innerHTML = '';
    if (state.remotes.length === 0) {
      // still show Add Remote button below
    }
    state.remotes.forEach(r => {
      const el = createTreeItem('☁', `${r.name} (${r.refs?.fetch || ''})`, '');
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Remove Remote', onClick: () => doRemoveRemote(r.name) }
        ]);
      });
      list.appendChild(el);
    });

    // Add Remote button
    const addEl = createTreeItem('+', 'Add Remote...', '');
    addEl.style.opacity = '0.7';
    addEl.addEventListener('click', showAddRemoteDialog);
    list.appendChild(addEl);
  }

  function createTreeItem(icon, text, cls) {
    const el = document.createElement('div');
    el.className = `tree-item ${cls}`;
    el.innerHTML = `<span class="tree-icon">${icon}</span> <span>${escapeHtml(text)}</span>`;
    return el;
  }

  // ─── File Status Rendering ────────────────────────────────

  function getStatsForFile(filePath, cached) {
    const statsArr = cached ? state.diffStatsCached : state.diffStats;
    return statsArr.find(s => s.path === filePath);
  }

  function renderFileStatus() {
    if (!state.status) return;
    const stagedEl = $('#staged-files');
    const unstagedEl = $('#unstaged-files');
    stagedEl.innerHTML = '';
    unstagedEl.innerHTML = '';

    const unstaged = [
      ...state.status.modified, ...state.status.not_added,
      ...state.status.deleted, ...state.status.created,
      ...state.status.conflicted, ...state.status.renamed
    ];

    // Update file counts in section headers
    const stagedCount = state.status.staged.length;
    const unstagedCount = new Set(unstaged.map(f => f.path)).size;
    const stagedHeader = $('#staged-section .file-section-header span');
    const unstagedHeader = $('#unstaged-section .file-section-header span');
    if (stagedHeader) stagedHeader.textContent = stagedCount > 0 ? `Staged Changes (${stagedCount})` : 'Staged Changes';
    if (unstagedHeader) unstagedHeader.textContent = unstagedCount > 0 ? `Unstaged Changes (${unstagedCount})` : 'Unstaged Changes';

    if (stagedCount === 0 && unstagedCount === 0) {
      stagedEl.innerHTML = '';
      unstagedEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">✓</span> Working tree clean</div>`;
      return;
    }

    state.status.staged.forEach(f => stagedEl.appendChild(createFileItem(f, true)));
    const seen = new Set();
    unstaged.forEach(f => {
      if (seen.has(f.path)) return;
      seen.add(f.path);
      unstagedEl.appendChild(createFileItem(f, false));
    });

    // Re-apply file search filter
    const q = fileSearchInput.value.toLowerCase();
    if (q) {
      $$('#unstaged-files .file-item, #staged-files .file-item').forEach(el => {
        el.style.display = (el.dataset.path || '').toLowerCase().includes(q) ? '' : 'none';
      });
    }

    initDragAndDrop();

    // Re-select previously selected file if still present
    if (state.selectedFile) {
      const allFileEls = Array.from($$('.file-item[data-path]'));
      const match = allFileEls.find(el => el.dataset.path === state.selectedFile);
      if (match) {
        match.classList.add('selected');
        const isStaged = match.dataset.staged === '1';
        showDiff(state.selectedFile, isStaged);
      }
    }
  }

  function createFileItem(file, isStaged) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = file.path;
    item.draggable = true;
    item.dataset.staged = isStaged ? '1' : '0';

    const statusChar = getStatusChar(file.status);
    const statusClass = file.status;
    const parts = file.path.split('/');
    const fileName = parts.pop();
    const dirPath = parts.length > 0 ? parts.join('/') + '/' : '';

    // Diff stats
    const stats = getStatsForFile(file.path, isStaged);
    const statsHtml = stats
      ? `<span class="file-stats"><span class="file-stats-add">+${stats.added}</span><span class="file-stats-del">-${stats.deleted}</span></span>`
      : '';

    item.innerHTML = `
      <span class="file-status ${statusClass}">${statusChar}</span>
      <span class="file-name"><span class="file-path-part">${escapeHtml(dirPath)}</span>${escapeHtml(fileName)}</span>
      ${statsHtml}
      <span class="file-actions">
        ${isStaged
          ? '<button class="file-action-btn" title="Unstage">−</button>'
          : '<button class="file-action-btn" title="Stage">+</button>'
        }
        ${!isStaged ? '<button class="file-action-btn discard-btn" title="Discard changes">✕</button>' : ''}
      </span>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.file-action-btn')) return;

      const parentList = isStaged ? '#staged-files' : '#unstaged-files';
      const allItems = Array.from($$(parentList + ' .file-item'));

      if (e.ctrlKey || e.metaKey) {
        // Toggle selection
        if (state.selectedFiles.has(file.path)) {
          state.selectedFiles.delete(file.path);
          item.classList.remove('selected');
        } else {
          state.selectedFiles.add(file.path);
          item.classList.add('selected');
        }
      } else if (e.shiftKey && state.lastClickedFile) {
        // Range selection
        const lastIdx = allItems.findIndex(el => el.dataset.path === state.lastClickedFile);
        const curIdx = allItems.findIndex(el => el.dataset.path === file.path);
        if (lastIdx >= 0 && curIdx >= 0) {
          const start = Math.min(lastIdx, curIdx);
          const end = Math.max(lastIdx, curIdx);
          state.selectedFiles.clear();
          allItems.forEach(el => el.classList.remove('selected'));
          for (let i = start; i <= end; i++) {
            state.selectedFiles.add(allItems[i].dataset.path);
            allItems[i].classList.add('selected');
          }
        }
      } else {
        // Normal click — single select
        state.selectedFiles.clear();
        $$('.file-item').forEach(fi => fi.classList.remove('selected'));
        state.selectedFiles.add(file.path);
        item.classList.add('selected');
      }

      state.lastClickedFile = file.path;
      state.selectedFile = file.path;
      showDiff(file.path, isStaged);
    });

    const actionBtns = item.querySelectorAll('.file-action-btn');
    actionBtns[0].addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        // If this file is in multi-selection, act on all selected
        const files = state.selectedFiles.size > 1 && state.selectedFiles.has(file.path)
          ? Array.from(state.selectedFiles)
          : [file.path];
        if (isStaged) await window.api.unstage(files);
        else await window.api.stage(files);
        state.selectedFiles.clear();
        await refresh();
      } catch (err) { toast(err.message, 'error'); }
    });

    const discardBtn = item.querySelector('.discard-btn');
    if (discardBtn) {
      discardBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Discard changes to ${file.path}?`)) {
          try {
            if (file.status === 'untracked' || file.status === 'created') {
              await window.api.discardUntracked(file.path);
            } else {
              await window.api.discardFile(file.path);
            }
            await refresh();
            toast('Changes discarded', 'info');
          } catch (err) { toast(err.message, 'error'); }
        }
      });
    }

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const fullPath = state.repoPath + '/' + file.path;
      const menuItems = [];

      // Multi-select actions
      if (state.selectedFiles.size > 1 && state.selectedFiles.has(file.path)) {
        const files = Array.from(state.selectedFiles);
        if (isStaged)
          menuItems.push({ label: `Unstage ${files.length} files`, onClick: async () => { await window.api.unstage(files); state.selectedFiles.clear(); await refresh(); } });
        else
          menuItems.push({ label: `Stage ${files.length} files`, onClick: async () => { await window.api.stage(files); state.selectedFiles.clear(); await refresh(); } });
        menuItems.push({ separator: true });
      }

      if (isStaged)
        menuItems.push({ label: 'Unstage', onClick: async () => { await window.api.unstage([file.path]); await refresh(); } });
      else
        menuItems.push({ label: 'Stage', onClick: async () => { await window.api.stage([file.path]); await refresh(); } });
      menuItems.push({ separator: true });
      menuItems.push({ label: 'View Diff', onClick: () => showDiff(file.path, isStaged) });
      menuItems.push({ label: 'File History', onClick: () => showFileHistory(file.path) });
      menuItems.push({ label: 'Blame', onClick: () => showBlame(file.path) });
      menuItems.push({ separator: true });
      menuItems.push({ label: 'Open in Editor', onClick: () => window.api.openFileInEditor(fullPath) });
      menuItems.push({ label: 'Reveal in File Explorer', onClick: () => window.api.showItemInFolder(fullPath) });
      menuItems.push({ label: 'Copy Path', onClick: () => { navigator.clipboard.writeText(file.path); toast('Path copied', 'info'); } });
      if (!isStaged) {
        menuItems.push({ separator: true });
        menuItems.push({ label: 'Discard Changes', onClick: async () => {
          if (confirm(`Discard changes to ${file.path}?`)) {
            if (file.status === 'untracked' || file.status === 'created') {
              await window.api.discardUntracked(file.path);
            } else {
              await window.api.discardFile(file.path);
            }
            await refresh();
          }
        }});
        if (file.status === 'untracked' || file.status === 'created') {
          menuItems.push({ label: 'Add to .gitignore', onClick: async () => {
            try {
              await window.api.addToGitignore(file.path);
              await refresh();
              toast(`Added "${file.path}" to .gitignore`, 'success');
            } catch (err) { toast(err.message, 'error'); }
          }});
        }
      }
      showContextMenu(e.clientX, e.clientY, menuItems);
    });

    return item;
  }

  function getStatusChar(status) {
    const map = { modified: 'M', added: 'A', deleted: 'D', untracked: '?', renamed: 'R', conflicted: '!', created: 'A', staged: 'S' };
    return map[status] || '?';
  }

  // ─── Drag & Drop Staging ──────────────────────────────────

  function initDragAndDrop() {
    const zones = $$('[data-drop-zone]');
    zones.forEach(zone => {
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const filePath = e.dataTransfer.getData('text/plain');
        const targetZone = zone.dataset.dropZone;
        if (!filePath) return;
        try {
          if (targetZone === 'staged') await window.api.stage([filePath]);
          else await window.api.unstage([filePath]);
          await refresh();
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    $$('.file-item[draggable]').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', item.dataset.path);
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
    });
  }

  // ─── Diff Display ────────────────────────────────────────

  async function showDiff(filePath, cached) {
    try {
      const diff = cached
        ? await window.api.diffCached(filePath)
        : await window.api.diff(filePath);
      $('#diff-header-text').textContent = filePath;
      state.lastDiffText = diff;
      state.lastDiffFile = filePath;
      state.lastDiffCached = cached;
      renderDiff(diff);
    } catch (err) {
      $('#diff-header-text').textContent = filePath;
      $('#diff-content').textContent = 'Unable to show diff: ' + err.message;
    }
  }

  function renderDiff(diffText) {
    if (state.diffMode === 'side') {
      renderDiffSideBySide(diffText);
    } else {
      renderDiffInline(diffText);
    }
  }

  function renderDiffInline(diffText) {
    const container = $('#diff-content');
    container.innerHTML = '';
    container.className = 'diff-content';

    if (!diffText || !diffText.trim()) {
      container.textContent = 'No changes to display';
      return;
    }

    const lines = diffText.split('\n');
    let oldLine = 0, newLine = 0;

    // Collect lines for word-level highlighting
    const parsed = [];
    lines.forEach(line => {
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (match) { oldLine = parseInt(match[1]); newLine = parseInt(match[2]); }
        parsed.push({ type: 'hunk', oldNum: '···', newNum: '···', content: line });
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        parsed.push({ type: 'added', oldNum: '', newNum: newLine++, content: line.substring(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        parsed.push({ type: 'removed', oldNum: oldLine++, newNum: '', content: line.substring(1) });
      } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        parsed.push({ type: 'meta', oldNum: '', newNum: '', content: line });
      } else {
        parsed.push({ type: 'context', oldNum: oldLine++, newNum: newLine++, content: line.startsWith(' ') ? line.substring(1) : line });
      }
    });

    // Render with word-level highlighting for adjacent -/+ pairs
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];

      // Check for adjacent removed→added pairs for word-level diff
      if (p.type === 'removed') {
        // Collect consecutive removed lines
        let remStart = i;
        while (i + 1 < parsed.length && parsed[i + 1].type === 'removed') i++;
        let remEnd = i;
        // Collect consecutive added lines after
        let addStart = i + 1;
        let addEnd = addStart - 1;
        while (addEnd + 1 < parsed.length && parsed[addEnd + 1].type === 'added') addEnd++;

        const remCount = remEnd - remStart + 1;
        const addCount = addEnd - addStart + 1;

        if (addCount > 0 && remCount <= 8 && addCount <= 8) {
          // Render word-level highlighted pairs
          const pairs = Math.max(remCount, addCount);
          for (let j = 0; j < pairs; j++) {
            const remLine = j < remCount ? parsed[remStart + j] : null;
            const addLine = j < addCount ? parsed[addStart + j] : null;
            if (remLine && addLine) {
              const [remHtml, addHtml] = wordDiffHighlight(remLine.content, addLine.content);
              container.appendChild(makeDiffLineEl(remLine.oldNum, remLine.newNum, remHtml, 'removed', true));
              container.appendChild(makeDiffLineEl(addLine.oldNum, addLine.newNum, addHtml, 'added', true));
            } else if (remLine) {
              container.appendChild(makeDiffLineEl(remLine.oldNum, remLine.newNum, escapeHtml(remLine.content), 'removed', true));
            } else if (addLine) {
              container.appendChild(makeDiffLineEl(addLine.oldNum, addLine.newNum, escapeHtml(addLine.content), 'added', true));
            }
          }
          i = addEnd;
          continue;
        } else {
          // No matching adds — render removed lines normally
          for (let j = remStart; j <= remEnd; j++) {
            container.appendChild(makeDiffLineEl(parsed[j].oldNum, parsed[j].newNum, escapeHtml(parsed[j].content), 'removed', true));
          }
          continue;
        }
      }

      const lineEl = document.createElement('div');
      lineEl.className = 'diff-line';
      if (p.type !== 'context') lineEl.classList.add(p.type);
      const numElOld = document.createElement('span');
      numElOld.className = 'diff-line-num';
      numElOld.textContent = p.oldNum;
      const numElNew = document.createElement('span');
      numElNew.className = 'diff-line-num';
      numElNew.textContent = p.newNum;
      const contentEl = document.createElement('span');
      contentEl.className = 'diff-line-content';
      contentEl.textContent = p.content;
      if (p.type === 'meta') lineEl.style.color = 'var(--text-muted)';
      lineEl.appendChild(numElOld);
      lineEl.appendChild(numElNew);
      lineEl.appendChild(contentEl);
      container.appendChild(lineEl);
    }
  }

  function makeDiffLineEl(oldNum, newNum, contentHtml, cls, isHtml) {
    const lineEl = document.createElement('div');
    lineEl.className = `diff-line ${cls}`;
    const numElOld = document.createElement('span');
    numElOld.className = 'diff-line-num';
    numElOld.textContent = oldNum;
    const numElNew = document.createElement('span');
    numElNew.className = 'diff-line-num';
    numElNew.textContent = newNum;
    const contentEl = document.createElement('span');
    contentEl.className = 'diff-line-content';
    if (isHtml) contentEl.innerHTML = contentHtml;
    else contentEl.textContent = contentHtml;
    lineEl.appendChild(numElOld);
    lineEl.appendChild(numElNew);
    lineEl.appendChild(contentEl);
    return lineEl;
  }

  function wordDiffHighlight(oldStr, newStr) {
    // Simple word-level diff
    const oldWords = oldStr.split(/(\s+)/);
    const newWords = newStr.split(/(\s+)/);
    // LCS-based diff on words
    const m = oldWords.length, n = newWords.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = oldWords[i - 1] === newWords[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    // Backtrack
    const oldMarked = new Array(m).fill(false);
    const newMarked = new Array(n).fill(false);
    let ci = m, cj = n;
    while (ci > 0 && cj > 0) {
      if (oldWords[ci - 1] === newWords[cj - 1]) { ci--; cj--; }
      else if (dp[ci - 1][cj] >= dp[ci][cj - 1]) { oldMarked[ci - 1] = true; ci--; }
      else { newMarked[cj - 1] = true; cj--; }
    }
    while (ci > 0) { oldMarked[ci - 1] = true; ci--; }
    while (cj > 0) { newMarked[cj - 1] = true; cj--; }

    let oldHtml = '', newHtml = '';
    for (let i = 0; i < m; i++) {
      if (oldMarked[i]) oldHtml += `<span class="word-del">${escapeHtml(oldWords[i])}</span>`;
      else oldHtml += escapeHtml(oldWords[i]);
    }
    for (let j = 0; j < n; j++) {
      if (newMarked[j]) newHtml += `<span class="word-add">${escapeHtml(newWords[j])}</span>`;
      else newHtml += escapeHtml(newWords[j]);
    }
    return [oldHtml, newHtml];
  }

  function renderDiffSideBySide(diffText) {
    const container = $('#diff-content');
    container.innerHTML = '';
    container.className = 'diff-content diff-side-by-side';

    if (!diffText || !diffText.trim()) {
      container.textContent = 'No changes to display';
      return;
    }

    const leftPane = document.createElement('div');
    leftPane.className = 'diff-side-pane';
    const rightPane = document.createElement('div');
    rightPane.className = 'diff-side-pane';

    const leftLabel = document.createElement('div');
    leftLabel.className = 'diff-side-label';
    leftLabel.textContent = 'Old';
    const rightLabel = document.createElement('div');
    rightLabel.className = 'diff-side-label';
    rightLabel.textContent = 'New';
    leftPane.appendChild(leftLabel);
    rightPane.appendChild(rightLabel);

    const lines = diffText.split('\n');
    let oldLine = 0, newLine = 0;

    lines.forEach(line => {
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (match) { oldLine = parseInt(match[1]); newLine = parseInt(match[2]); }
        const hunkL = makeDiffLine('···', line, 'hunk');
        const hunkR = makeDiffLine('···', line, 'hunk');
        leftPane.appendChild(hunkL);
        rightPane.appendChild(hunkR);
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        leftPane.appendChild(makeDiffLine('', '', 'empty-placeholder'));
        rightPane.appendChild(makeDiffLine(newLine++, line.substring(1), 'added'));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        leftPane.appendChild(makeDiffLine(oldLine++, line.substring(1), 'removed'));
        rightPane.appendChild(makeDiffLine('', '', 'empty-placeholder'));
      } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        // skip meta lines in side-by-side
      } else {
        const content = line.startsWith(' ') ? line.substring(1) : line;
        leftPane.appendChild(makeDiffLine(oldLine++, content, ''));
        rightPane.appendChild(makeDiffLine(newLine++, content, ''));
      }
    });

    container.appendChild(leftPane);
    container.appendChild(rightPane);

    // Sync scroll
    leftPane.addEventListener('scroll', () => { rightPane.scrollTop = leftPane.scrollTop; });
    rightPane.addEventListener('scroll', () => { leftPane.scrollTop = rightPane.scrollTop; });
  }

  function makeDiffLine(num, content, cls) {
    const lineEl = document.createElement('div');
    lineEl.className = `diff-line ${cls}`;
    const numEl = document.createElement('span');
    numEl.className = 'diff-line-num';
    numEl.textContent = num;
    const contentEl = document.createElement('span');
    contentEl.className = 'diff-line-content';
    contentEl.textContent = content;
    lineEl.appendChild(numEl);
    lineEl.appendChild(contentEl);
    return lineEl;
  }

  // ─── Commit List (History) ────────────────────────────────

  const GRAPH_COLORS = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7', '#fab387', '#94e2d5', '#f5c2e7', '#74c7ec', '#b4befe'];

  function computeGraph(commits) {
    // Build graph lanes for each commit
    const lanes = []; // active lanes: each is a commit hash we're "waiting for"
    const graphData = [];

    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      const parents = commit.parents || [];

      // Find this commit's lane
      let myLane = lanes.indexOf(commit.hash);
      if (myLane === -1) {
        // New branch: assign to first empty slot or append
        myLane = lanes.indexOf(null);
        if (myLane === -1) {
          myLane = lanes.length;
          lanes.push(commit.hash);
        } else {
          lanes[myLane] = commit.hash;
        }
      }

      const lanesBefore = lanes.slice();

      // Build connections: for each lane, where does it continue?
      const connections = []; // {from: laneIdx, to: laneIdx, type: 'pass'|'merge'|'branch'}

      // First parent continues in the same lane
      if (parents.length > 0) {
        lanes[myLane] = parents[0];
      } else {
        lanes[myLane] = null; // end of history for this lane
      }

      // Additional parents (merge): find or create lanes
      const mergeLanes = [];
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        let existingLane = lanes.indexOf(parentHash);
        if (existingLane === -1) {
          // Assign to empty slot or new lane
          let slot = lanes.indexOf(null);
          if (slot === -1) {
            slot = lanes.length;
            lanes.push(parentHash);
          } else {
            lanes[slot] = parentHash;
          }
          existingLane = slot;
        }
        mergeLanes.push(existingLane);
      }

      // Pass-through connections for other active lanes
      for (let l = 0; l < lanesBefore.length; l++) {
        if (l === myLane) continue;
        if (lanesBefore[l] !== null) {
          const newIdx = lanes.indexOf(lanesBefore[l]);
          if (newIdx !== -1) {
            connections.push({ from: l, to: newIdx });
          }
        }
      }

      // Clean up trailing nulls
      while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

      graphData.push({
        lane: myLane,
        numLanes: Math.max(lanes.length, lanesBefore.length, myLane + 1),
        mergeLanes,
        connections,
        isMerge: parents.length > 1
      });
    }

    return graphData;
  }

  function renderCommitList() {
    const tbody = $('#commit-list');
    tbody.innerHTML = '';

    const graphData = computeGraph(state.log);
    const LANE_W = 14;
    const ROW_H = 28;
    const DOT_R = 4;

    state.log.forEach((commit, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.hash = commit.hash;

      const g = graphData[idx];
      const svgW = (g.numLanes + 1) * LANE_W;
      const graphTd = document.createElement('td');
      graphTd.className = 'col-graph';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', svgW);
      svg.setAttribute('height', ROW_H);
      svg.style.display = 'block';

      const cx = g.lane * LANE_W + LANE_W / 2;
      const cy = ROW_H / 2;

      // Draw pass-through lines
      g.connections.forEach(c => {
        const x1 = c.from * LANE_W + LANE_W / 2;
        const x2 = c.to * LANE_W + LANE_W / 2;
        if (x1 === x2) {
          // Straight pass-through
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', x1);
          line.setAttribute('y1', 0);
          line.setAttribute('x2', x2);
          line.setAttribute('y2', ROW_H);
          line.setAttribute('stroke', GRAPH_COLORS[c.from % GRAPH_COLORS.length]);
          line.setAttribute('stroke-width', '2');
          svg.appendChild(line);
        } else {
          // Bezier curve for lane changes
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M ${x1} 0 C ${x1} ${ROW_H * 0.5}, ${x2} ${ROW_H * 0.5}, ${x2} ${ROW_H}`);
          path.setAttribute('stroke', GRAPH_COLORS[c.from % GRAPH_COLORS.length]);
          path.setAttribute('stroke-width', '2');
          path.setAttribute('fill', 'none');
          svg.appendChild(path);
        }
      });

      // Main lane vertical line (above and below the dot)
      const mainLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      mainLine.setAttribute('x1', cx);
      mainLine.setAttribute('y1', 0);
      mainLine.setAttribute('x2', cx);
      mainLine.setAttribute('y2', ROW_H);
      mainLine.setAttribute('stroke', GRAPH_COLORS[g.lane % GRAPH_COLORS.length]);
      mainLine.setAttribute('stroke-width', '2');
      svg.appendChild(mainLine);

      // Merge lines from merge parents
      g.mergeLanes.forEach(ml => {
        const mx = ml * LANE_W + LANE_W / 2;
        if (cx === mx) {
          const mergeLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          mergeLine.setAttribute('x1', cx);
          mergeLine.setAttribute('y1', cy);
          mergeLine.setAttribute('x2', mx);
          mergeLine.setAttribute('y2', ROW_H);
          mergeLine.setAttribute('stroke', GRAPH_COLORS[ml % GRAPH_COLORS.length]);
          mergeLine.setAttribute('stroke-width', '2');
          svg.appendChild(mergeLine);
        } else {
          const mergePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          mergePath.setAttribute('d', `M ${cx} ${cy} C ${cx} ${ROW_H}, ${mx} ${cy}, ${mx} ${ROW_H}`);
          mergePath.setAttribute('stroke', GRAPH_COLORS[ml % GRAPH_COLORS.length]);
          mergePath.setAttribute('stroke-width', '2');
          mergePath.setAttribute('fill', 'none');
          svg.appendChild(mergePath);
        }
      });

      // Dot
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('r', g.isMerge ? DOT_R + 1 : DOT_R);
      dot.setAttribute('fill', GRAPH_COLORS[g.lane % GRAPH_COLORS.length]);
      dot.setAttribute('stroke', 'var(--bg-primary)');
      dot.setAttribute('stroke-width', '2');
      svg.appendChild(dot);

      graphTd.appendChild(svg);
      tr.appendChild(graphTd);

      const descTd = document.createElement('td');
      let refsHtml = '';
      if (commit.refs) {
        commit.refs.split(', ').filter(Boolean).forEach(ref => {
          let cls = 'branch', label = ref;
          if (ref.startsWith('tag: ')) { cls = 'tag'; label = ref.replace('tag: ', ''); }
          else if (ref === 'HEAD') cls = 'head';
          else if (ref.includes('/')) cls = 'remote';
          refsHtml += `<span class="commit-ref ${cls}">${escapeHtml(label)}</span>`;
        });
      }
      descTd.innerHTML = `<span class="commit-refs">${refsHtml}</span>${escapeHtml(commit.message)}`;
      tr.appendChild(descTd);

      const dateTd = document.createElement('td');
      dateTd.textContent = formatRelativeDate(commit.date);
      dateTd.title = formatDate(commit.date);
      tr.appendChild(dateTd);

      const authorTd = document.createElement('td');
      authorTd.textContent = commit.author;
      tr.appendChild(authorTd);

      const hashTd = document.createElement('td');
      hashTd.textContent = commit.hashShort;
      hashTd.style.fontFamily = 'var(--font-mono)';
      tr.appendChild(hashTd);

      tr.addEventListener('click', () => {
        $$('.commit-table tbody tr').forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');
        state.selectedCommit = commit.hash;
        showCommitDetail(commit.hash);
      });

      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Copy SHA', onClick: () => navigator.clipboard.writeText(commit.hash) },
          { label: 'Cherry-pick', onClick: () => doCherryPick(commit.hash) },
          { label: 'Revert', onClick: () => doRevert(commit.hash) },
          { separator: true },
          { label: 'Reset (soft)', onClick: () => doReset(commit.hash, '--soft') },
          { label: 'Reset (mixed)', onClick: () => doReset(commit.hash, '--mixed') },
          { label: 'Reset (hard)', onClick: () => doReset(commit.hash, '--hard') },
          { separator: true },
          { label: 'Create Tag here...', onClick: () => showCreateTagDialog(commit.hash) },
          { label: 'Create Branch here...', onClick: () => showCreateBranchDialog(commit.hash) }
        ]);
      });

      tbody.appendChild(tr);
    });
  }

  async function showCommitDetail(hash) {
    const detail = $('#commit-detail');
    const diffPanel = $('#commit-diff-content');
    try {
      const [data, files] = await Promise.all([
        window.api.showCommit(hash),
        window.api.commitFiles(hash)
      ]);
      const meta = data.meta || {};

      // Rich header
      let headerHtml = `<div class="commit-detail-header">
        <div class="commit-hash" title="Click to copy">${escapeHtml(meta.hash || hash)}</div>
        <div class="commit-msg">${escapeHtml(meta.message || '')}</div>
        <div class="commit-meta">
          <strong>Author:</strong> ${escapeHtml(meta.author || '')} &nbsp;·&nbsp; ${escapeHtml(meta.authorDate || '')}<br>
          ${meta.committer ? `<strong>Committer:</strong> ${escapeHtml(meta.committer)} &nbsp;·&nbsp; ${escapeHtml(meta.commitDate || '')}` : ''}
        </div>
      </div>`;

      // File list
      const filesHtml = files.map(f => {
        const cls = f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : 'modified';
        return `<div class="file-item" data-commit-file="${escapeHtml(f.path)}" data-commit-hash="${escapeHtml(hash)}">
          <span class="file-status ${cls}">${f.status}</span>
          <span class="file-name">${escapeHtml(f.path)}</span>
        </div>`;
      }).join('');

      detail.innerHTML = `
        ${headerHtml}
        <div class="commit-detail-files">
          <h4 style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Changed Files (${files.length})</h4>
          ${filesHtml}
        </div>
      `;

      // Copy hash on click
      detail.querySelector('.commit-hash')?.addEventListener('click', () => {
        navigator.clipboard.writeText(meta.hash || hash);
        toast('SHA copied', 'info');
      });

      // Clickable files → show colored diff in right panel
      detail.querySelectorAll('.file-item[data-commit-file]').forEach(el => {
        el.addEventListener('click', async () => {
          detail.querySelectorAll('.file-item').forEach(fi => fi.classList.remove('selected'));
          el.classList.add('selected');
          const filePath = el.dataset.commitFile;
          const commitHash = el.dataset.commitHash;
          try {
            const fileDiff = await window.api.commitFileDiff(commitHash, filePath);
            state.lastCommitDiffText = fileDiff;
            $('#commit-diff-title').textContent = filePath;
            renderCommitDiff(fileDiff);
          } catch (err) {
            if (diffPanel) diffPanel.textContent = 'Error: ' + err.message;
          }
        });
      });

      // Auto-show full commit diff by default
      state.lastCommitDiffText = data.diff;
      $('#commit-diff-title').textContent = 'Full Commit Diff';
      renderCommitDiff(data.diff);

    } catch (err) {
      detail.innerHTML = `<div class="commit-detail-placeholder">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ─── Commit diff mode state ───────────────────────────────
  state.commitDiffMode = 'inline';

  $('#btn-commit-diff-inline').addEventListener('click', () => {
    state.commitDiffMode = 'inline';
    $('#btn-commit-diff-inline').classList.add('btn-active');
    $('#btn-commit-diff-side').classList.remove('btn-active');
    if (state.lastCommitDiffText) renderCommitDiff(state.lastCommitDiffText);
  });
  $('#btn-commit-diff-side').addEventListener('click', () => {
    state.commitDiffMode = 'side';
    $('#btn-commit-diff-side').classList.add('btn-active');
    $('#btn-commit-diff-inline').classList.remove('btn-active');
    if (state.lastCommitDiffText) renderCommitDiff(state.lastCommitDiffText);
  });

  function renderCommitDiff(diffText) {
    const container = $('#commit-diff-content');
    if (!container) return;
    container.innerHTML = '';
    container.className = 'commit-diff-content';

    if (!diffText || !diffText.trim()) {
      container.textContent = 'No diff to display';
      return;
    }

    if (state.commitDiffMode === 'side') {
      renderCommitDiffSideBySide(diffText, container);
    } else {
      renderCommitDiffInline(diffText, container);
    }
  }

  function renderCommitDiffInline(diffText, container) {
    const lines = diffText.split('\n');
    let oldLine = 0, newLine = 0;

    const parsed = [];
    lines.forEach(line => {
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (match) { oldLine = parseInt(match[1]); newLine = parseInt(match[2]); }
        parsed.push({ type: 'hunk', oldNum: '···', newNum: '···', content: line });
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        parsed.push({ type: 'added', oldNum: '', newNum: newLine++, content: line.substring(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        parsed.push({ type: 'removed', oldNum: oldLine++, newNum: '', content: line.substring(1) });
      } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        parsed.push({ type: 'meta', oldNum: '', newNum: '', content: line });
      } else {
        parsed.push({ type: 'context', oldNum: oldLine++, newNum: newLine++, content: line.startsWith(' ') ? line.substring(1) : line });
      }
    });

    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      if (p.type === 'removed') {
        let remStart = i;
        while (i + 1 < parsed.length && parsed[i + 1].type === 'removed') i++;
        let remEnd = i;
        let addStart = i + 1, addEnd = addStart - 1;
        while (addEnd + 1 < parsed.length && parsed[addEnd + 1].type === 'added') addEnd++;
        const remCount = remEnd - remStart + 1;
        const addCount = addEnd - addStart + 1;
        if (addCount > 0 && remCount <= 8 && addCount <= 8) {
          const pairs = Math.max(remCount, addCount);
          for (let j = 0; j < pairs; j++) {
            const remLine = j < remCount ? parsed[remStart + j] : null;
            const addLine = j < addCount ? parsed[addStart + j] : null;
            if (remLine && addLine) {
              const [remHtml, addHtml] = wordDiffHighlight(remLine.content, addLine.content);
              container.appendChild(makeDiffLineEl(remLine.oldNum, remLine.newNum, remHtml, 'removed', true));
              container.appendChild(makeDiffLineEl(addLine.oldNum, addLine.newNum, addHtml, 'added', true));
            } else if (remLine) {
              container.appendChild(makeDiffLineEl(remLine.oldNum, remLine.newNum, escapeHtml(remLine.content), 'removed', true));
            } else if (addLine) {
              container.appendChild(makeDiffLineEl(addLine.oldNum, addLine.newNum, escapeHtml(addLine.content), 'added', true));
            }
          }
          i = addEnd;
          continue;
        } else {
          for (let j = remStart; j <= remEnd; j++) {
            container.appendChild(makeDiffLineEl(parsed[j].oldNum, parsed[j].newNum, escapeHtml(parsed[j].content), 'removed', true));
          }
          continue;
        }
      }
      const lineEl = document.createElement('div');
      lineEl.className = 'diff-line';
      if (p.type !== 'context') lineEl.classList.add(p.type);
      const numElOld = document.createElement('span');
      numElOld.className = 'diff-line-num';
      numElOld.textContent = p.oldNum;
      const numElNew = document.createElement('span');
      numElNew.className = 'diff-line-num';
      numElNew.textContent = p.newNum;
      const contentEl = document.createElement('span');
      contentEl.className = 'diff-line-content';
      contentEl.textContent = p.content;
      if (p.type === 'meta') lineEl.style.color = 'var(--text-muted)';
      lineEl.appendChild(numElOld);
      lineEl.appendChild(numElNew);
      lineEl.appendChild(contentEl);
      container.appendChild(lineEl);
    }
  }

  function renderCommitDiffSideBySide(diffText, container) {
    container.classList.add('diff-side-by-side');

    const leftPane = document.createElement('div');
    leftPane.className = 'diff-side-pane';
    const rightPane = document.createElement('div');
    rightPane.className = 'diff-side-pane';

    const leftLabel = document.createElement('div');
    leftLabel.className = 'diff-side-label';
    leftLabel.textContent = 'Old';
    const rightLabel = document.createElement('div');
    rightLabel.className = 'diff-side-label';
    rightLabel.textContent = 'New';
    leftPane.appendChild(leftLabel);
    rightPane.appendChild(rightLabel);

    const lines = diffText.split('\n');
    let oldLine = 0, newLine = 0;

    lines.forEach(line => {
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (match) { oldLine = parseInt(match[1]); newLine = parseInt(match[2]); }
        leftPane.appendChild(makeDiffLine('···', line, 'hunk'));
        rightPane.appendChild(makeDiffLine('···', line, 'hunk'));
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        leftPane.appendChild(makeDiffLine('', '', 'empty-placeholder'));
        rightPane.appendChild(makeDiffLine(newLine++, line.substring(1), 'added'));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        leftPane.appendChild(makeDiffLine(oldLine++, line.substring(1), 'removed'));
        rightPane.appendChild(makeDiffLine('', '', 'empty-placeholder'));
      } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        // skip meta
      } else {
        const content = line.startsWith(' ') ? line.substring(1) : line;
        leftPane.appendChild(makeDiffLine(oldLine++, content, ''));
        rightPane.appendChild(makeDiffLine(newLine++, content, ''));
      }
    });

    container.appendChild(leftPane);
    container.appendChild(rightPane);

    leftPane.addEventListener('scroll', () => { rightPane.scrollTop = leftPane.scrollTop; });
    rightPane.addEventListener('scroll', () => { leftPane.scrollTop = rightPane.scrollTop; });
  }

  // ═════════════════════════════════════════════════════════
  //  GIT OPERATIONS (dialogs & actions)
  // ═════════════════════════════════════════════════════════

  async function stageAll() {
    try { await window.api.stageAll(); await refresh(); toast('All files staged', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function unstageAll() {
    try { await window.api.unstageAll(); await refresh(); toast('All files unstaged', 'info'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function doCommit() {
    // Build message with conventional commits prefix
    const type = commitType.value;
    const scope = commitScope.value.trim();
    let rawMsg = commitMsg.value.trim();
    if (!rawMsg && !type) return toast('Please enter a commit message', 'error');
    let finalMsg = rawMsg;
    if (type) {
      const prefix = scope ? `${type}(${scope}): ` : `${type}: `;
      // Don't double-add prefix if user already typed it
      if (!rawMsg.startsWith(prefix) && !rawMsg.startsWith(type + ':') && !rawMsg.startsWith(type + '(')) {
        finalMsg = prefix + rawMsg;
      }
    }
    if (!finalMsg) return toast('Please enter a commit message', 'error');
    const amend = $('#commit-amend').checked;
    try {
      showLoading('Committing...');
      await window.api.commit(finalMsg, amend);
      addCommitHistory(finalMsg);
      commitMsg.value = '';
      commitType.value = '';
      commitScope.value = '';
      $('#commit-amend').checked = false;
      updateCharCount();
      await refresh();
      toast('Changes committed', 'success');
    } catch (err) {
      toast('Commit failed: ' + err.message, 'error');
    } finally { hideLoading(); }
  }

  // Amend loads previous commit message
  $('#commit-amend')?.addEventListener('change', async (e) => {
    if (e.target.checked) {
      try {
        const msg = await window.api.lastCommitMessage();
        if (msg) commitMsg.value = msg;
        updateCharCount();
      } catch (_) { /* ignore */ }
    }
  });

  // Rebase continue / abort wiring
  $('#btn-rebase-continue')?.addEventListener('click', async () => {
    try {
      showLoading('Continuing rebase...');
      await window.api.rebaseContinue();
      await refresh();
      toast('Rebase continued', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  });
  $('#btn-rebase-abort')?.addEventListener('click', async () => {
    try {
      showLoading('Aborting rebase...');
      await window.api.rebaseAbort();
      await refresh();
      toast('Rebase aborted', 'info');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  });

  async function doFetch() {
    try {
      showLoading('Fetching...');
      await window.api.fetch(null, true);
      await refresh();
      toast('Fetch complete', 'success');
    } catch (err) {
      toast('Fetch failed: ' + err.message, 'error');
    } finally { hideLoading(); }
  }

  function showPullDialog() {
    const remoteOpts = state.remotes.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
    showModal('Pull', `
      <div class="form-group">
        <label>Remote</label>
        <select id="pull-remote">${remoteOpts || '<option value="origin">origin</option>'}</select>
      </div>
      <div class="form-group">
        <label>Branch (leave empty for current)</label>
        <input id="pull-branch" type="text" placeholder="">
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="pull-rebase"> Rebase instead of merge</label>
      </div>
    `, [{
      label: 'Pull', primary: true, onClick: async () => {
        const remote = document.getElementById('pull-remote').value;
        const branch = document.getElementById('pull-branch').value.trim() || undefined;
        const rebase = document.getElementById('pull-rebase').checked;
        try {
          showLoading('Pulling...');
          await window.api.pull(remote, branch, rebase);
          await refresh();
          toast('Pull complete', 'success');
        } catch (err) { toast('Pull failed: ' + err.message, 'error'); }
        finally { hideLoading(); }
      }
    }]);
  }

  function showPushDialog() {
    const remoteOpts = state.remotes.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
    showModal('Push', `
      <div class="form-group">
        <label>Remote</label>
        <select id="push-remote">${remoteOpts || '<option value="origin">origin</option>'}</select>
      </div>
      <div class="form-group">
        <label>Branch (leave empty for current)</label>
        <input id="push-branch" type="text" placeholder="">
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="push-set-upstream"> Set upstream (--set-upstream)</label>
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="push-force"> Force push</label>
      </div>
    `, [{
      label: 'Push', primary: true, onClick: async () => {
        const remote = document.getElementById('push-remote').value;
        const branch = document.getElementById('push-branch').value.trim() || undefined;
        const force = document.getElementById('push-force').checked;
        const setUpstream = document.getElementById('push-set-upstream').checked;
        try {
          showLoading('Pushing...');
          if (setUpstream) {
            await window.api.pushWithUpstream(remote, branch);
          } else {
            await window.api.push(remote, branch, force);
          }
          await refresh();
          toast('Push complete', 'success');
        } catch (err) { toast('Push failed: ' + err.message, 'error'); }
        finally { hideLoading(); }
      }
    }]);
  }

  function showCreateBranchDialog(startPoint) {
    showModal('Create Branch', `
      <div class="form-group">
        <label>Branch Name</label>
        <input id="branch-name" type="text" placeholder="feature/my-branch">
      </div>
      ${typeof startPoint === 'string' ? `<p style="font-size:12px;color:var(--text-muted)">From: ${escapeHtml(startPoint.substring(0, 10))}</p>` : ''}
    `, [{
      label: 'Create & Checkout', primary: true, onClick: async () => {
        const name = document.getElementById('branch-name').value.trim();
        if (!name) return toast('Branch name is required', 'error');
        try {
          await window.api.createBranch(name, typeof startPoint === 'string' ? startPoint : undefined);
          await refresh();
          toast(`Branch "${name}" created`, 'success');
        } catch (err) { toast(err.message, 'error'); }
      }
    }]);
  }

  function showMergeDialog() {
    if (!state.branches) return toast('No branches loaded', 'error');
    const opts = state.branches.local.filter(b => b !== state.branches.current)
      .map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    showModal('Merge', `
      <div class="form-group">
        <label>Merge into: <strong>${escapeHtml(state.branches.current)}</strong></label>
        <select id="merge-branch">${opts}</select>
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="merge-noff"> No fast-forward (--no-ff)</label>
      </div>
    `, [{
      label: 'Merge', primary: true, onClick: async () => {
        const branch = document.getElementById('merge-branch').value;
        const noFf = document.getElementById('merge-noff').checked;
        await doMerge(branch, noFf);
      }
    }]);
  }

  function showRebaseDialog() {
    if (!state.branches) return;
    const opts = state.branches.local.filter(b => b !== state.branches.current)
      .map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    showModal('Rebase', `
      <div class="form-group">
        <label>Rebase <strong>${escapeHtml(state.branches.current)}</strong> onto:</label>
        <select id="rebase-branch">${opts}</select>
      </div>
    `, [{
      label: 'Rebase', primary: true, onClick: async () => {
        const branch = document.getElementById('rebase-branch').value;
        await doRebase(branch);
      }
    }]);
  }

  function showCreateTagDialog(commitHash) {
    showModal('Create Tag', `
      <div class="form-group"><label>Tag Name</label><input id="tag-name" type="text" placeholder="v1.0.0"></div>
      <div class="form-group"><label>Message (optional, creates annotated tag)</label><input id="tag-message" type="text" placeholder=""></div>
      ${typeof commitHash === 'string' ? `<p style="font-size:12px;color:var(--text-muted)">At: ${escapeHtml(commitHash.substring(0, 10))}</p>` : ''}
    `, [{
      label: 'Create Tag', primary: true, onClick: async () => {
        const name = document.getElementById('tag-name').value.trim();
        const message = document.getElementById('tag-message').value.trim() || undefined;
        if (!name) return toast('Tag name is required', 'error');
        try {
          await window.api.createTag(name, message, typeof commitHash === 'string' ? commitHash : undefined);
          await refresh();
          toast(`Tag "${name}" created`, 'success');
        } catch (err) { toast(err.message, 'error'); }
      }
    }]);
  }

  async function checkoutBranch(branch) {
    try {
      showLoading(`Checking out ${branch}...`);
      await window.api.checkout(branch);
      await refresh();
      toast(`Checked out "${branch}"`, 'success');
    } catch (err) { toast('Checkout failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  async function deleteBranch(name) {
    if (!confirm(`Delete branch "${name}"?`)) return;
    try {
      await window.api.deleteBranch(name, false);
      await refresh();
      toast(`Branch "${name}" deleted`, 'success');
    } catch (err) {
      if (err.message.includes('not fully merged')) {
        if (confirm(`Branch "${name}" is not fully merged. Force delete?`)) {
          await window.api.deleteBranch(name, true);
          await refresh();
          toast(`Branch "${name}" force deleted`, 'success');
        }
      } else toast(err.message, 'error');
    }
  }

  async function doMerge(branch, noFf = false) {
    try {
      showLoading(`Merging ${branch}...`);
      await window.api.merge(branch, noFf);
      await refresh();
      toast(`Merged "${branch}"`, 'success');
    } catch (err) { toast('Merge failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  async function doRebase(branch) {
    try {
      showLoading(`Rebasing onto ${branch}...`);
      await window.api.rebase(branch);
      await refresh();
      toast(`Rebased onto "${branch}"`, 'success');
    } catch (err) { toast('Rebase failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  async function doStash() {
    showModal('Stash Changes', `
      <div class="form-group">
        <label>Message (optional)</label>
        <input id="stash-message" type="text" placeholder="WIP: describe your changes...">
      </div>
      <div class="form-group">
        <label class="checkbox-label"><input type="checkbox" id="stash-untracked" checked> Include untracked files</label>
      </div>
    `, [{
      label: 'Stash', primary: true, onClick: async () => {
        const msg = document.getElementById('stash-message').value.trim() || undefined;
        const includeUntracked = document.getElementById('stash-untracked').checked;
        try {
          await window.api.stash(msg, includeUntracked);
          await refresh();
          toast('Changes stashed', 'success');
        } catch (err) { toast('Stash failed: ' + err.message, 'error'); }
      }
    }]);
  }

  async function doStashPop() {
    try { await window.api.stashPop(0); await refresh(); toast('Stash popped', 'success'); }
    catch (err) { toast('Stash pop failed: ' + err.message, 'error'); }
  }

  async function doStashPopIndex(index) {
    try { await window.api.stashPop(index); await refresh(); toast('Stash popped', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function doStashApplyIndex(index) {
    try { await window.api.stashApply(index); await refresh(); toast('Stash applied (kept in stash list)', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function doStashDrop(index) {
    if (!confirm(`Drop stash@{${index}}?`)) return;
    try { await window.api.stashDrop(index); await refresh(); toast('Stash dropped', 'info'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function doDeleteTag(name) {
    if (!confirm(`Delete tag "${name}"?`)) return;
    try { await window.api.deleteTag(name); await refresh(); toast(`Tag "${name}" deleted`, 'info'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function doPushTag(name) {
    try {
      showLoading(`Pushing tag "${name}"...`);
      await window.api.pushTag(name);
      toast(`Tag "${name}" pushed to remote`, 'success');
    } catch (err) { toast('Push tag failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  async function doRemoveRemote(name) {
    if (!confirm(`Remove remote "${name}"?`)) return;
    try { await window.api.removeRemote(name); await refresh(); toast(`Remote "${name}" removed`, 'info'); }
    catch (err) { toast(err.message, 'error'); }
  }

  function showAddRemoteDialog() {
    showModal('Add Remote', `
      <div class="form-group">
        <label>Remote Name</label>
        <input id="remote-name" type="text" placeholder="origin">
      </div>
      <div class="form-group">
        <label>Remote URL</label>
        <input id="remote-url" type="text" placeholder="https://github.com/user/repo.git">
      </div>
    `, [{
      label: 'Add', primary: true, onClick: async () => {
        const name = document.getElementById('remote-name').value.trim();
        const url = document.getElementById('remote-url').value.trim();
        if (!name || !url) return toast('Name and URL are required', 'error');
        try {
          await window.api.addRemote(name, url);
          hideModal();
          await refresh();
          toast(`Remote "${name}" added`, 'success');
        } catch (err) { toast(err.message, 'error'); }
      }
    }, { label: 'Cancel', onClick: hideModal }]);
  }

  // ─── GitFlow ──────────────────────────────────────────────

  function renderGitFlow() {
    const section = $('#gitflow-section');
    const statusEl = $('#gitflow-status');
    const list = $('#gitflow-list');
    if (!section || !statusEl || !list) return;

    list.innerHTML = '';
    statusEl.innerHTML = '';

    if (!state.gitflow) {
      statusEl.innerHTML = '<div class="gitflow-not-init"><span>GitFlow not initialized</span><button class="btn btn-small btn-primary" id="btn-gitflow-init-sidebar">Initialize</button></div>';
      const initBtn = statusEl.querySelector('#btn-gitflow-init-sidebar');
      if (initBtn) initBtn.addEventListener('click', showGitFlowInitDialog);
      return;
    }

    const gf = state.gitflow;
    statusEl.innerHTML = `<div class="gitflow-info"><span class="gitflow-badge master">${escapeHtml(gf.config.master)}</span> <span class="gitflow-badge develop">${escapeHtml(gf.config.develop)}</span></div>`;

    // Features
    if (gf.features.length > 0) {
      const header = document.createElement('div');
      header.className = 'gitflow-group-header';
      header.textContent = 'Features';
      list.appendChild(header);
      gf.features.forEach(name => {
        const fullName = gf.config.featurePrefix + name;
        const isCurrent = gf.current === fullName;
        const el = createTreeItem(isCurrent ? '●' : '🌿', name, isCurrent ? 'current-branch' : '');
        el.addEventListener('click', () => checkoutBranch(fullName));
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'Checkout', onClick: () => checkoutBranch(fullName) },
            { label: 'Finish Feature', onClick: () => doGitFlowFeatureFinish(name) },
            { separator: true },
            { label: 'Delete Branch', onClick: () => deleteBranch(fullName) }
          ]);
        });
        list.appendChild(el);
      });
    }

    // Releases
    if (gf.releases.length > 0) {
      const header = document.createElement('div');
      header.className = 'gitflow-group-header';
      header.textContent = 'Releases';
      list.appendChild(header);
      gf.releases.forEach(name => {
        const fullName = gf.config.releasePrefix + name;
        const isCurrent = gf.current === fullName;
        const el = createTreeItem(isCurrent ? '●' : '🚀', name, isCurrent ? 'current-branch' : '');
        el.addEventListener('click', () => checkoutBranch(fullName));
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'Checkout', onClick: () => checkoutBranch(fullName) },
            { label: 'Finish Release', onClick: () => showGitFlowReleaseFinishDialogFor(name) },
            { separator: true },
            { label: 'Delete Branch', onClick: () => deleteBranch(fullName) }
          ]);
        });
        list.appendChild(el);
      });
    }

    // Hotfixes
    if (gf.hotfixes.length > 0) {
      const header = document.createElement('div');
      header.className = 'gitflow-group-header';
      header.textContent = 'Hotfixes';
      list.appendChild(header);
      gf.hotfixes.forEach(name => {
        const fullName = gf.config.hotfixPrefix + name;
        const isCurrent = gf.current === fullName;
        const el = createTreeItem(isCurrent ? '●' : '🔥', name, isCurrent ? 'current-branch' : '');
        el.addEventListener('click', () => checkoutBranch(fullName));
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'Checkout', onClick: () => checkoutBranch(fullName) },
            { label: 'Finish Hotfix', onClick: () => showGitFlowHotfixFinishDialogFor(name) },
            { separator: true },
            { label: 'Delete Branch', onClick: () => deleteBranch(fullName) }
          ]);
        });
        list.appendChild(el);
      });
    }

    if (gf.features.length === 0 && gf.releases.length === 0 && gf.hotfixes.length === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:8px;font-size:12px">No active GitFlow branches</div>';
    }
  }

  function showGitFlowMenu() {
    if (!state.repoPath) return toast('No repository opened', 'error');
    const btn = $('#tb-gitflow');
    const rect = btn.getBoundingClientRect();
    const items = [];
    if (!state.gitflow) {
      items.push({ label: '⚙ Initialize GitFlow...', onClick: showGitFlowInitDialog });
    } else {
      items.push({ label: '🌿 Start Feature...', onClick: showGitFlowFeatureStartDialog });
      items.push({ label: '✅ Finish Feature...', onClick: showGitFlowFeatureFinishDialog });
      items.push({ separator: true });
      items.push({ label: '🚀 Start Release...', onClick: showGitFlowReleaseStartDialog });
      items.push({ label: '✅ Finish Release...', onClick: showGitFlowReleaseFinishDialog });
      items.push({ separator: true });
      items.push({ label: '🔥 Start Hotfix...', onClick: showGitFlowHotfixStartDialog });
      items.push({ label: '✅ Finish Hotfix...', onClick: showGitFlowHotfixFinishDialog });
      items.push({ separator: true });
      items.push({ label: '⚙ Re-initialize GitFlow...', onClick: showGitFlowInitDialog });
    }
    showContextMenu(rect.left, rect.bottom + 4, items);
  }

  function showGitFlowInitDialog() {
    const gf = state.gitflow;
    showModal('Initialize GitFlow', `
      <div class="form-group"><label>Production branch (master/main)</label><input id="gf-master" type="text" value="${gf ? escapeHtml(gf.config.master) : 'main'}"></div>
      <div class="form-group"><label>Development branch</label><input id="gf-develop" type="text" value="${gf ? escapeHtml(gf.config.develop) : 'develop'}"></div>
      <div class="form-group"><label>Feature prefix</label><input id="gf-feature" type="text" value="${gf ? escapeHtml(gf.config.featurePrefix) : 'feature/'}"></div>
      <div class="form-group"><label>Release prefix</label><input id="gf-release" type="text" value="${gf ? escapeHtml(gf.config.releasePrefix) : 'release/'}"></div>
      <div class="form-group"><label>Hotfix prefix</label><input id="gf-hotfix" type="text" value="${gf ? escapeHtml(gf.config.hotfixPrefix) : 'hotfix/'}"></div>
      <div class="form-group"><label>Version tag prefix</label><input id="gf-versiontag" type="text" value="${gf ? escapeHtml(gf.config.versionTagPrefix) : ''}" placeholder="(optional, e.g. v)"></div>
    `, [{
      label: 'Initialize', primary: true, onClick: async () => {
        try {
          showLoading('Initializing GitFlow...');
          await window.api.gitflowInit({
            master: document.getElementById('gf-master').value.trim() || 'main',
            develop: document.getElementById('gf-develop').value.trim() || 'develop',
            featurePrefix: document.getElementById('gf-feature').value.trim() || 'feature/',
            releasePrefix: document.getElementById('gf-release').value.trim() || 'release/',
            hotfixPrefix: document.getElementById('gf-hotfix').value.trim() || 'hotfix/',
            versionTagPrefix: document.getElementById('gf-versiontag').value.trim() || ''
          });
          await refresh();
          toast('GitFlow initialized', 'success');
        } catch (err) { toast('GitFlow init failed: ' + err.message, 'error'); }
        finally { hideLoading(); }
      }
    }]);
  }

  function showGitFlowFeatureStartDialog() {
    if (!state.gitflow) return toast('GitFlow not initialized', 'error');
    showModal('Start Feature', `
      <div class="form-group"><label>Feature Name</label><input id="gf-feat-name" type="text" placeholder="my-feature"></div>
      <p style="font-size:12px;color:var(--text-muted)">Branch: ${escapeHtml(state.gitflow.config.featurePrefix)}&lt;name&gt; from ${escapeHtml(state.gitflow.config.develop)}</p>
    `, [{
      label: 'Start Feature', primary: true, onClick: async () => {
        const name = document.getElementById('gf-feat-name').value.trim();
        if (!name) return toast('Feature name is required', 'error');
        try {
          showLoading('Starting feature...');
          await window.api.gitflowFeatureStart(name);
          await refresh();
          toast(`Feature "${name}" started`, 'success');
        } catch (err) { toast(err.message, 'error'); }
        finally { hideLoading(); }
      }
    }]);
  }

  function showGitFlowFeatureFinishDialog() {
    if (!state.gitflow) return toast('GitFlow not initialized', 'error');
    const features = state.gitflow.features;
    if (features.length === 0) return toast('No active features to finish', 'error');
    const opts = features.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
    showModal('Finish Feature', `
      <div class="form-group"><label>Feature</label><select id="gf-feat-finish">${opts}</select></div>
      <p style="font-size:12px;color:var(--text-muted)">Merges into ${escapeHtml(state.gitflow.config.develop)} with --no-ff</p>
    `, [{
      label: 'Finish Feature', primary: true, onClick: async () => {
        const name = document.getElementById('gf-feat-finish').value;
        await doGitFlowFeatureFinish(name);
      }
    }]);
  }

  async function doGitFlowFeatureFinish(name) {
    try {
      showLoading(`Finishing feature "${name}"...`);
      await window.api.gitflowFeatureFinish(name);
      await refresh();
      toast(`Feature "${name}" finished`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  }

  function showGitFlowReleaseStartDialog() {
    if (!state.gitflow) return toast('GitFlow not initialized', 'error');
    showModal('Start Release', `
      <div class="form-group"><label>Version</label><input id="gf-rel-version" type="text" placeholder="1.0.0"></div>
      <p style="font-size:12px;color:var(--text-muted)">Branch: ${escapeHtml(state.gitflow.config.releasePrefix)}&lt;version&gt; from ${escapeHtml(state.gitflow.config.develop)}</p>
    `, [{
      label: 'Start Release', primary: true, onClick: async () => {
        const version = document.getElementById('gf-rel-version').value.trim();
        if (!version) return toast('Version is required', 'error');
        try {
          showLoading('Starting release...');
          await window.api.gitflowReleaseStart(version);
          await refresh();
          toast(`Release "${version}" started`, 'success');
        } catch (err) { toast(err.message, 'error'); }
        finally { hideLoading(); }
      }
    }]);
  }

  function showGitFlowReleaseFinishDialog() {
    if (!state.gitflow) return toast('GitFlow not initialized', 'error');
    const releases = state.gitflow.releases;
    if (releases.length === 0) return toast('No active releases to finish', 'error');
    const opts = releases.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
    showModal('Finish Release', `
      <div class="form-group"><label>Release</label><select id="gf-rel-finish">${opts}</select></div>
      <div class="form-group"><label>Tag Message (optional)</label><input id="gf-rel-tag-msg" type="text" placeholder="Release version description..."></div>
      <p style="font-size:12px;color:var(--text-muted)">Merges into ${escapeHtml(state.gitflow.config.master)} and ${escapeHtml(state.gitflow.config.develop)}, creates tag</p>
    `, [{
      label: 'Finish Release', primary: true, onClick: async () => {
        const version = document.getElementById('gf-rel-finish').value;
        const tagMsg = document.getElementById('gf-rel-tag-msg').value.trim() || undefined;
        await doGitFlowReleaseFinish(version, tagMsg);
      }
    }]);
  }

  function showGitFlowReleaseFinishDialogFor(version) {
    showModal(`Finish Release: ${version}`, `
      <div class="form-group"><label>Tag Message (optional)</label><input id="gf-rel-tag-msg" type="text" placeholder="Release version description..."></div>
      <p style="font-size:12px;color:var(--text-muted)">Merges into ${escapeHtml(state.gitflow.config.master)} and ${escapeHtml(state.gitflow.config.develop)}, creates tag</p>
    `, [{
      label: 'Finish Release', primary: true, onClick: async () => {
        const tagMsg = document.getElementById('gf-rel-tag-msg').value.trim() || undefined;
        await doGitFlowReleaseFinish(version, tagMsg);
      }
    }]);
  }

  async function doGitFlowReleaseFinish(version, tagMsg) {
    try {
      showLoading(`Finishing release "${version}"...`);
      await window.api.gitflowReleaseFinish(version, tagMsg);
      await refresh();
      toast(`Release "${version}" finished`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  }

  function showGitFlowHotfixStartDialog() {
    if (!state.gitflow) return toast('GitFlow not initialized', 'error');
    showModal('Start Hotfix', `
      <div class="form-group"><label>Version</label><input id="gf-hot-version" type="text" placeholder="1.0.1"></div>
      <p style="font-size:12px;color:var(--text-muted)">Branch: ${escapeHtml(state.gitflow.config.hotfixPrefix)}&lt;version&gt; from ${escapeHtml(state.gitflow.config.master)}</p>
    `, [{
      label: 'Start Hotfix', primary: true, onClick: async () => {
        const version = document.getElementById('gf-hot-version').value.trim();
        if (!version) return toast('Version is required', 'error');
        try {
          showLoading('Starting hotfix...');
          await window.api.gitflowHotfixStart(version);
          await refresh();
          toast(`Hotfix "${version}" started`, 'success');
        } catch (err) { toast(err.message, 'error'); }
        finally { hideLoading(); }
      }
    }]);
  }

  function showGitFlowHotfixFinishDialog() {
    if (!state.gitflow) return toast('GitFlow not initialized', 'error');
    const hotfixes = state.gitflow.hotfixes;
    if (hotfixes.length === 0) return toast('No active hotfixes to finish', 'error');
    const opts = hotfixes.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');
    showModal('Finish Hotfix', `
      <div class="form-group"><label>Hotfix</label><select id="gf-hot-finish">${opts}</select></div>
      <div class="form-group"><label>Tag Message (optional)</label><input id="gf-hot-tag-msg" type="text" placeholder="Hotfix description..."></div>
      <p style="font-size:12px;color:var(--text-muted)">Merges into ${escapeHtml(state.gitflow.config.master)} and ${escapeHtml(state.gitflow.config.develop)}, creates tag</p>
    `, [{
      label: 'Finish Hotfix', primary: true, onClick: async () => {
        const version = document.getElementById('gf-hot-finish').value;
        const tagMsg = document.getElementById('gf-hot-tag-msg').value.trim() || undefined;
        await doGitFlowHotfixFinish(version, tagMsg);
      }
    }]);
  }

  function showGitFlowHotfixFinishDialogFor(version) {
    showModal(`Finish Hotfix: ${version}`, `
      <div class="form-group"><label>Tag Message (optional)</label><input id="gf-hot-tag-msg" type="text" placeholder="Hotfix description..."></div>
      <p style="font-size:12px;color:var(--text-muted)">Merges into ${escapeHtml(state.gitflow.config.master)} and ${escapeHtml(state.gitflow.config.develop)}, creates tag</p>
    `, [{
      label: 'Finish Hotfix', primary: true, onClick: async () => {
        const tagMsg = document.getElementById('gf-hot-tag-msg').value.trim() || undefined;
        await doGitFlowHotfixFinish(version, tagMsg);
      }
    }]);
  }

  async function doGitFlowHotfixFinish(version, tagMsg) {
    try {
      showLoading(`Finishing hotfix "${version}"...`);
      await window.api.gitflowHotfixFinish(version, tagMsg);
      await refresh();
      toast(`Hotfix "${version}" finished`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  }

  // ─── Branch Comparison ────────────────────────────────────

  function showBranchCompareDialog() {
    if (!state.branches) return toast('No branches loaded', 'error');
    const allBranches = [...state.branches.local, ...state.branches.remote];
    const opts = allBranches.map(b => `<option value="${escapeHtml(b)}" ${b === state.branches.current ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('');
    const opts2 = allBranches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    showModal('Compare Branches', `
      <div class="form-group">
        <label>From (base)</label>
        <select id="compare-from">${opts}</select>
      </div>
      <div class="form-group">
        <label>To (compare)</label>
        <select id="compare-to">${opts2}</select>
      </div>
    `, [{
      label: 'Compare', primary: true, onClick: async () => {
        const from = document.getElementById('compare-from').value;
        const to = document.getElementById('compare-to').value;
        if (from === to) return toast('Select two different branches', 'error');
        hideModal();
        await showBranchDiff(from, to);
      }
    }]);
  }

  async function showBranchDiff(from, to) {
    try {
      setStatus(`Comparing ${from}...${to}`);
      const diff = await window.api.branchDiff(from, to);
      // Show in the diff viewer
      switchView('status');
      $('#diff-header-text').textContent = `${from} → ${to}`;
      state.lastDiffText = diff;
      renderDiff(diff);
      setStatus('Ready');
    } catch (err) {
      toast('Compare failed: ' + err.message, 'error');
    }
  }

  async function doUpdateSubmodule(subPath) {
    try {
      showLoading('Updating submodule...');
      await window.api.updateSubmodule(subPath);
      await refresh();
      toast('Submodule updated', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  }

  async function doCherryPick(hash) {
    try { showLoading('Cherry-picking...'); await window.api.cherryPick(hash); await refresh(); toast('Cherry-pick successful', 'success'); }
    catch (err) { toast('Cherry-pick failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  async function doRevert(hash) {
    try { showLoading('Reverting...'); await window.api.revert(hash); await refresh(); toast('Revert successful', 'success'); }
    catch (err) { toast('Revert failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  async function doReset(hash, mode) {
    const modeLabel = mode.replace('--', '');
    if (mode === '--hard') {
      if (!confirm(`Hard reset to ${hash.substring(0, 7)}? All uncommitted changes will be LOST!`)) return;
    }
    try { showLoading(`Resetting (${modeLabel})...`); await window.api.reset(hash, mode); await refresh(); toast(`Reset (${modeLabel}) complete`, 'success'); }
    catch (err) { toast('Reset failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  // ─── File History / Blame ─────────────────────────────────

  async function showFileHistory(filePath) {
    try {
      const history = await window.api.fileHistory(filePath);
      const rows = history.map(h =>
        `<tr><td style="font-family:var(--font-mono)">${escapeHtml(h.hashShort)}</td><td>${escapeHtml(h.message)}</td><td>${formatDate(h.date)}</td><td>${escapeHtml(h.author)}</td></tr>`
      ).join('');
      showModal(`File History: ${filePath}`, `
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">SHA</th><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Message</th><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Date</th><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Author</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `, []);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function showBlame(filePath) {
    try {
      const blame = await window.api.blame(filePath);
      const lines = blame.map(b => `
        <div class="blame-line">
          <span class="blame-info">${escapeHtml(b.author || '')} · ${escapeHtml(b.summary || '')} · ${b.hash ? b.hash.substring(0, 7) : ''}</span>
          <span class="blame-code">${escapeHtml(b.content || '')}</span>
        </div>
      `).join('');
      showModal(`Blame: ${filePath}`, `<div class="blame-view">${lines}</div>`, []);
    } catch (err) { toast(err.message, 'error'); }
  }

  // ═════════════════════════════════════════════════════════
  //  HELPERS
  // ═════════════════════════════════════════════════════════

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return dateStr;
    }
  }

  function formatRelativeDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const now = Date.now();
      const diffSec = Math.floor((now - d.getTime()) / 1000);
      if (diffSec < 60) return 'just now';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) return `${diffDay}d ago`;
      const diffMo = Math.floor(diffDay / 30);
      if (diffMo < 12) return `${diffMo}mo ago`;
      const diffYr = Math.floor(diffDay / 365);
      return `${diffYr}y ago`;
    } catch {
      return dateStr;
    }
  }

  // ─── History Panel Resize (horizontal) ──────────────────
  (function initHistoryResize() {
    const handle = $('#history-resize-handle');
    const rightPanel = $('#history-right');
    if (!handle || !rightPanel) return;
    let startX, startWidth;
    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startWidth = rightPanel.offsetWidth;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e) {
      const newWidth = Math.max(280, Math.min(window.innerWidth * 0.7, startWidth - (e.clientX - startX)));
      rightPanel.style.width = newWidth + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  })();

  // ─── Keyboard shortcuts ───────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideModal();
      hideShortcuts();
      removeContextMenu();
      return;
    }
    // Ignore shortcuts when typing in input/textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Allow Ctrl+Enter in textarea
      return;
    }
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      e.preventDefault();
      showShortcuts();
    }
    if (e.ctrlKey && e.key === '1') { e.preventDefault(); switchView('status'); }
    if (e.ctrlKey && e.key === '2') { e.preventDefault(); switchView('history'); }
    if (e.key === 'F5') { e.preventDefault(); refresh(); }
    if (e.ctrlKey && e.key === 'o') { e.preventDefault(); openRepo(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); doFetch(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'P') { e.preventDefault(); showPullDialog(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'U') { e.preventDefault(); showPushDialog(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'B') { e.preventDefault(); showCreateBranchDialog(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'S') { e.preventDefault(); doStash(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'G') { e.preventDefault(); showGitFlowMenu(); }

    // Arrow keys to navigate file list (status view only)
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.currentView === 'status') {
      const allFiles = Array.from($$('#staged-files .file-item, #unstaged-files .file-item')).filter(el => el.style.display !== 'none');
      if (allFiles.length === 0) return;
      e.preventDefault();
      const currentIdx = allFiles.findIndex(el => el.dataset.path === state.selectedFile);
      let newIdx;
      if (e.key === 'ArrowDown') {
        newIdx = currentIdx < allFiles.length - 1 ? currentIdx + 1 : 0;
      } else {
        newIdx = currentIdx > 0 ? currentIdx - 1 : allFiles.length - 1;
      }
      allFiles[newIdx].click();
      allFiles[newIdx].scrollIntoView({ block: 'nearest' });
    }
  });

  // ─── Restore saved tab session on startup ──────────────
  (async () => {
    const session = loadTabSession();
    if (session && session.tabs && session.tabs.length > 0) {
      for (const tab of session.tabs) {
        try {
          await openRepoPath(tab.path);
        } catch (_) { /* skip repos that no longer exist */ }
      }
      // Switch to previously active tab
      if (typeof session.activeIdx === 'number' && state.tabs[session.activeIdx]) {
        switchTab(session.activeIdx);
      }
    }
  })();

})();
