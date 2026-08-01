// =====================================================================
// KitsuneGIT — Renderer (app.js)
// Full-featured frontend: multi-tab, themes, drag-drop, search,
// conventional commits, side-by-side diff, settings, file watcher, etc.
// =====================================================================

(function () {
  'use strict';

  const LANGUAGE_KEY = 'kitsune_language';
  let currentLanguage = localStorage.getItem(LANGUAGE_KEY) || (navigator.language.toLowerCase().startsWith('pl') ? 'pl' : 'en');
  const translations = {
    en: {
      subtitle: 'Fast & Lightweight Git Client', open: 'Open Repository', clone: 'Clone Repository', init: 'Init New Repository',
      configureGit: 'Configure Git', diagnostics: 'System check', recent: 'Recent Repositories', fetch: 'Fetch', pull: 'Pull', push: 'Push',
      branch: 'Branch', merge: 'Merge', stash: 'Stash', tag: 'Tag', compare: 'Compare', tools: 'Tools', automations: 'Automations', terminal: 'Terminal', settings: 'Settings',
      staged: 'Staged Changes', unstaged: 'Unstaged Changes', commit: 'Commit', branchLabel: 'Branch', ready: 'Ready'
    },
    pl: {
      subtitle: 'Szybki i lekki klient Git', open: 'Otwórz repozytorium', clone: 'Klonuj repozytorium', init: 'Utwórz repozytorium',
      configureGit: 'Skonfiguruj Git', diagnostics: 'Diagnostyka', recent: 'Ostatnie repozytoria', fetch: 'Pobierz', pull: 'Ściągnij', push: 'Wyślij',
      branch: 'Gałąź', merge: 'Scal', stash: 'Schowek', tag: 'Tag', compare: 'Porównaj', tools: 'Narzędzia', automations: 'Makra', terminal: 'Terminal', settings: 'Ustawienia',
      staged: 'Zmiany w indeksie', unstaged: 'Zmiany poza indeksem', commit: 'Zatwierdź', branchLabel: 'Gałąź', ready: 'Gotowe'
    }
  };

  function t(key) { return translations[currentLanguage]?.[key] || translations.en[key] || key; }

  function applyLanguage() {
    document.documentElement.lang = currentLanguage;
    const text = (selector, value) => { const element = $(selector); if (element) element.textContent = value; };
    const html = (selector, value) => { const element = $(selector); if (element) element.innerHTML = value; };
    text('#welcome-subtitle', t('subtitle'));
    html('#btn-open-repo', `<span class="icon">📂</span> ${t('open')}`);
    html('#btn-clone-repo', `<span class="icon">⬇</span> ${t('clone')}`);
    html('#btn-init-repo', `<span class="icon">✨</span> ${t('init')}`);
    text('#btn-runtime-setup', t('configureGit'));
    text('#btn-diagnostics', t('diagnostics'));
    text('.recent-title', t('recent'));
    html('#tb-fetch', `🔄 ${t('fetch')}`);
    html('#tb-branch', `🌿 ${t('branch')}`);
    html('#tb-merge', `🔀 ${t('merge')}`);
    html('#tb-stash', `📦 ${t('stash')}`);
    html('#tb-tag', `🏷 ${t('tag')}`);
    html('#tb-compare', `🔍 ${t('compare')}`);
    html('#tb-tools', `🧰 ${t('tools')}`);
    html('#tb-automations', `⚡ ${t('automations')}`);
    html('#tb-terminal', `💻 ${t('terminal')}`);
    html('#tb-settings', `⚙ ${t('settings')}`);
    text('#label-staged-changes', t('staged'));
    text('#label-unstaged-changes', t('unstaged'));
    text('#btn-commit', t('commit'));
    text('#tb-language', currentLanguage === 'pl' ? 'EN' : 'PL');
  }

  function toggleLanguage() {
    currentLanguage = currentLanguage === 'pl' ? 'en' : 'pl';
    localStorage.setItem(LANGUAGE_KEY, currentLanguage);
    applyLanguage();
    renderToolbar();
    renderStatusBar();
  }

  const parsedAutoFetch = Number.parseInt(localStorage.getItem('kitsune_autofetch') || '0', 10);
  const storedAutoFetch = [0, 1, 3, 5, 10, 15].includes(parsedAutoFetch) ? parsedAutoFetch : 0;

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
    operation: null,
    gitflow: null,  // {config, features, releases, hotfixes, current}
    runtime: null,
    automations: [],
    autoFetchInterval: null,
    autoFetchMinutes: storedAutoFetch // 0 = disabled
  };

  // ─── DOM refs ─────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const welcomeScreen = $('#welcome-screen');
  const appEl = $('#app');

  // ─── Session Tabs (localStorage) ──────────────────────────
  const TABS_KEY = 'kitsune_open_tabs';
  function isStoredPath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 32_767 && !/[\0\r\n]/.test(value);
  }
  function saveTabSession() {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      tabs: state.tabs,
      activeIdx: state.activeTabIdx
    }));
  }
  function loadTabSession() {
    try {
      const data = JSON.parse(localStorage.getItem(TABS_KEY));
      if (data && Array.isArray(data.tabs)) {
        const tabs = data.tabs
          .filter(tab => tab && isStoredPath(tab.path))
          .slice(0, 20)
          .map(tab => ({ path: tab.path, name: tab.path.split(/[\\/]/).pop() }));
        if (tabs.length > 0) {
          const activeIdx = Number.isInteger(data.activeIdx)
            ? Math.min(Math.max(data.activeIdx, 0), tabs.length - 1)
            : 0;
          return { tabs, activeIdx };
        }
      }
    } catch { /* noop */ }
    return null;
  }

  // ─── Recent Repos (localStorage) ─────────────────────────
  const RECENT_KEY = 'kitsune_recent_repos';
  function getRecentRepos() {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_KEY));
      return Array.isArray(parsed) ? parsed.filter(isStoredPath).slice(0, 10) : [];
    } catch {
      return [];
    }
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
  applyLanguage();

  // ─── Version in status bar ────────────────────────────────
  (async () => {
    try {
      const version = await window.api.getVersion();
      const el = $('#statusbar-version');
      if (el) el.textContent = `v${version}`;
    } catch { /* ignore */ }
  })();

  function runtimeLabel(runtime) {
    if (!runtime?.selected) return runtime?.error || 'No usable Git runtime';
    const source = runtime.selected.source === 'managed' ? 'Managed' : runtime.selected.source === 'custom' ? 'Custom' : 'System';
    return `${source} Git ${runtime.selected.version}`;
  }

  async function refreshRuntimeIndicators() {
    try {
      state.runtime = await window.api.runtimeStatus(state.repoPath);
      const label = runtimeLabel(state.runtime);
      const welcome = $('#welcome-runtime-status');
      if (welcome) {
        welcome.textContent = label;
        welcome.className = state.runtime.selected ? 'runtime-ok' : 'runtime-error';
      }
      if (!state.runtime.selected && !localStorage.getItem('kitsune_onboarding_diagnostics_v1')) {
        localStorage.setItem('kitsune_onboarding_diagnostics_v1', 'shown');
        setTimeout(() => void showDiagnosticsDialog(), 300);
      }
      const statusbar = $('#statusbar-runtime');
      if (statusbar) {
        statusbar.textContent = state.runtime.selected ? `Git ${state.runtime.selected.version}` : 'Git unavailable';
        statusbar.title = state.runtime.selected?.binary || state.runtime.error || '';
        statusbar.className = `statusbar-runtime ${state.runtime.selected ? 'runtime-ok' : 'runtime-error'}`;
      }
      return state.runtime;
    } catch (error) {
      const welcome = $('#welcome-runtime-status');
      if (welcome) {
        welcome.textContent = `Git check failed: ${error.message}`;
        welcome.className = 'runtime-error';
      }
      return null;
    }
  }

  window.api.onRuntimeProgress(progress => {
    const text = $('#runtime-progress-text');
    const value = $('#runtime-progress-value');
    if (text) text.textContent = progress?.message || 'Working...';
    if (value) value.style.width = `${Math.max(0, Math.min(100, Number(progress?.percent) || 0))}%`;
  });

  function renderOperationQueue(queue) {
    const element = $('#statusbar-operation');
    if (!element) return;
    if (!queue?.active && !queue?.pending?.length) {
      element.classList.add('hidden');
      element.innerHTML = '';
      return;
    }
    const active = queue.active;
    element.classList.remove('hidden');
    element.innerHTML = active
      ? `<span>⏳ ${escapeHtml(active.label)}${queue.pending.length ? ` (+${queue.pending.length})` : ''}</span><button class="statusbar-cancel" title="Cancel operation">✕</button>`
      : `<span>${queue.pending.length} queued</span>`;
    element.querySelector('.statusbar-cancel')?.addEventListener('click', async () => {
      try { await window.api.cancelQueuedOperation(active.id); }
      catch (error) { toast(error.message, 'error'); }
    });
  }

  window.api.onOperationQueueChange(renderOperationQueue);
  void window.api.operationQueueStatus().then(renderOperationQueue).catch(() => {});
  window.api.onAutomationEvent(event => {
    if (event?.phase === 'step-start') {
      const loadingText = $('#loading-text');
      if (loadingText) loadingText.textContent = `⚡ ${event.step?.label || 'Running automation...'}`;
    } else if (event?.phase === 'macro-complete' && event.result?.trigger === 'after_commit') {
      toast(`Hook “${event.macroName}” completed`, 'success');
    } else if (event?.phase === 'hook-failed') {
      toast(`Commit succeeded, but hook “${event.macroName}” failed: ${event.message}`, 'error');
    }
  });

  void refreshRuntimeIndicators();

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
    return false;
  }

  function setStatus(text) {
    $('#statusbar-text').textContent = text;
  }

  // ─── Modal ────────────────────────────────────────────────
  let _modalEnterHandler = null;
  let _modalPreviousFocus = null;
  function showModal(title, bodyHTML, buttons = []) {
    _modalPreviousFocus = document.activeElement;
    $('#modal').classList.remove('modal-wide', 'modal-automation', 'modal-automation-editor');
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHTML;
    const footer = $('#modal-footer');
    footer.innerHTML = '';
    const primaryBtn = buttons.find(b => b.primary);
    let primaryElement = null;
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}`;
      btn.textContent = b.label;
      btn.onclick = async () => {
        if (btn.disabled) return;
        const modalButtons = Array.from(footer.querySelectorAll('button'));
        modalButtons.forEach(element => { element.disabled = true; });
        try {
          const result = await b.onClick();
          if (result !== false) hideModal();
        } catch (error) {
          toast(error.message || String(error), 'error');
        } finally {
          modalButtons.forEach(element => { element.disabled = false; });
        }
      };
      if (b.primary) primaryElement = btn;
      footer.appendChild(btn);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
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
    if (primaryBtn && primaryElement) {
      _modalEnterHandler = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && document.activeElement?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          primaryElement.click();
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
    if (_modalPreviousFocus && typeof _modalPreviousFocus.focus === 'function') {
      _modalPreviousFocus.focus();
    }
    _modalPreviousFocus = null;
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

  function showCommandPalette() {
    const requiresRepo = Boolean(state.repoPath);
    const commands = [
      { label: 'Open repository', keywords: 'file folder', action: openRepo },
      { label: 'Clone repository', keywords: 'remote download', action: showCloneDialog },
      { label: 'Initialize repository', keywords: 'new init', action: showInitDialog },
      { label: 'Refresh', keywords: 'reload status', action: refresh, enabled: requiresRepo },
      { label: 'Fetch all remotes', keywords: 'sync network', action: doFetch, enabled: requiresRepo },
      { label: 'Pull changes', keywords: 'sync download', action: showPullDialog, enabled: requiresRepo },
      { label: 'Push changes', keywords: 'sync upload', action: showPushDialog, enabled: requiresRepo },
      { label: 'Create branch', keywords: 'branch checkout', action: showCreateBranchDialog, enabled: requiresRepo },
      { label: 'Merge branch', keywords: 'branch integrate', action: showMergeDialog, enabled: requiresRepo },
      { label: 'Rebase branch', keywords: 'history rewrite', action: showRebaseDialog, enabled: requiresRepo },
      { label: 'Resolve conflicts', keywords: 'merge rebase', action: showConflictCenter, enabled: Boolean(state.status?.conflicted?.length) },
      { label: 'Advanced repository tools', keywords: 'worktree reflog bisect patch lfs sparse maintenance', action: showAdvancedToolsDialog, enabled: requiresRepo },
      { label: 'Automation Studio', keywords: 'macro workflow hook blocks', action: showAutomationStudio, enabled: requiresRepo },
      { label: 'Credentials and SSH keys', keywords: 'gcm auth key password', action: showAuthenticationDialog },
      { label: 'System diagnostics', keywords: 'doctor git runtime check', action: showDiagnosticsDialog },
      { label: 'Settings', keywords: 'configuration runtime', action: showSettingsDialog },
      { label: 'Open terminal', keywords: 'shell console', action: () => window.api.openInTerminal(state.repoPath), enabled: requiresRepo },
      { label: 'Toggle theme', keywords: 'dark light appearance', action: toggleTheme },
      { label: 'Show keyboard shortcuts', keywords: 'help keys', action: showShortcuts }
    ].filter(command => command.enabled !== false);
    showModal('Command Palette', `
      <input id="command-search" class="command-search" placeholder="Type a command..." autocomplete="off">
      <div id="command-results" class="command-results"></div>
    `, []);
    const input = $('#command-search');
    const results = $('#command-results');
    let filtered = commands;
    let selected = 0;
    const render = () => {
      results.innerHTML = filtered.map((command, index) => `<button class="command-item ${index === selected ? 'selected' : ''}" data-index="${index}">${escapeHtml(command.label)}</button>`).join('') || '<div class="empty-inline">No matching commands</div>';
      $$('.command-item').forEach(button => button.addEventListener('click', () => execute(Number(button.dataset.index))));
    };
    const execute = index => {
      const command = filtered[index];
      if (!command) return;
      hideModal();
      setTimeout(() => void command.action(), 0);
    };
    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      filtered = commands.filter(command => `${command.label} ${command.keywords}`.toLowerCase().includes(query));
      selected = 0;
      render();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); render(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
      if (event.key === 'Enter') { event.preventDefault(); execute(selected); }
    });
    render();
  }

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
  $('#btn-runtime-setup').addEventListener('click', showSettingsDialog);
  $('#btn-diagnostics').addEventListener('click', showDiagnosticsDialog);

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
  $('#tb-tools').addEventListener('click', showAdvancedToolsDialog);
  $('#tb-automations').addEventListener('click', showAutomationStudio);
  $('#tb-gitflow').addEventListener('click', (e) => { e.stopPropagation(); showGitFlowMenu(); });
  $('#tb-terminal').addEventListener('click', () => {
    if (state.repoPath) window.api.openInTerminal(state.repoPath);
    else toast('No repository opened', 'error');
  });
  $('#tb-settings').addEventListener('click', showSettingsDialog);
  $('#tb-refresh').addEventListener('click', refresh);
  $('#tb-command').addEventListener('click', showCommandPalette);
  $('#tb-language').addEventListener('click', toggleLanguage);
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
  $('#btn-apply-selected-lines').addEventListener('click', () => {
    void applyDiffSelection(selectedDiffLines(), state.lastDiffCached ? 'unstage' : 'stage');
  });
  $('#btn-discard-selected-lines').addEventListener('click', () => {
    void applyDiffSelection(selectedDiffLines(), 'discard');
  });
  $('#btn-diff-inline').addEventListener('click', () => {
    state.diffMode = 'inline';
    $('#btn-diff-inline').classList.add('btn-active');
    $('#btn-diff-side').classList.remove('btn-active');
    if (state.lastDiffText) renderDiff(state.lastDiffText);
    updateDiffSelectionControls();
  });
  $('#btn-diff-side').addEventListener('click', () => {
    state.diffMode = 'side';
    $('#btn-diff-side').classList.add('btn-active');
    $('#btn-diff-inline').classList.remove('btn-active');
    if (state.lastDiffText) renderDiff(state.lastDiffText);
    updateDiffSelectionControls();
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
          const status = await window.api.fetch(null, true);
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

  function resetRepositoryViewState() {
    state.selectedFile = null;
    state.selectedCommit = null;
    state.selectedFiles.clear();
    state.lastClickedFile = null;
    state.log = [];
    state.lastDiffText = '';
    state.lastDiffFile = null;
    state.lastCommitDiffText = '';
    state.operation = null;
    $('#diff-header-text').textContent = 'Select a file to view changes';
    $('#diff-content').textContent = '';
    $('#commit-detail').innerHTML = '<div class="commit-detail-placeholder">Select a commit to view details</div>';
  }

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
    let index = state.tabs.findIndex(t => t.path === repoPath);
    if (index < 0) {
      state.tabs.push({ path: repoPath, name });
      index = state.tabs.length - 1;
    }
    state.activeTabIdx = index;
    renderTabs();
    saveTabSession();
    return index;
  }

  async function switchTab(idx, force = false) {
    const tab = state.tabs[idx];
    if (!tab || (!force && idx === state.activeTabIdx && state.repoPath === tab.path)) return true;
    try {
      showLoading('Switching repository...');
      const status = await window.api.openRepo(tab.path);
      state.activeTabIdx = idx;
      state.repoPath = tab.path;
      state.status = status;
      resetRepositoryViewState();
      renderTabs();
      await refresh();
      await window.api.startWatcher(tab.path);
      saveTabSession();
      return true;
    } catch (err) {
      toast('Failed to switch: ' + err.message, 'error');
      renderTabs();
      return false;
    } finally {
      hideLoading();
    }
  }

  async function closeTab(idx) {
    if (!state.tabs[idx]) return;
    const wasActive = idx === state.activeTabIdx;
    state.tabs.splice(idx, 1);
    if (state.tabs.length === 0) {
      state.activeTabIdx = -1;
      state.repoPath = null;
      state.status = null;
      await window.api.stopWatcher();
      appEl.classList.add('hidden');
      welcomeScreen.classList.remove('hidden');
    } else if (wasActive) {
      const nextIndex = Math.min(idx, state.tabs.length - 1);
      state.activeTabIdx = -1;
      await switchTab(nextIndex, true);
    } else {
      if (idx < state.activeTabIdx) state.activeTabIdx -= 1;
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

  async function openRepoPath(dir, { notify = true } = {}) {
    try {
      showLoading('Opening repository...');
      setStatus('Opening repository...');
      const status = await window.api.openRepo(dir);
      state.repoPath = dir;
      state.status = status;
      resetRepositoryViewState();
      addRecentRepo(dir);
      addTab(dir);
      enterApp();
      await window.api.startWatcher(dir);
      await refresh();
      if (notify) toast('Repository opened', 'success');
      return true;
    } catch (err) {
      if (notify) toast('Failed to open repository: ' + err.message, 'error');
      return false;
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
          const status = await window.api.clone(url, targetPath);
          state.repoPath = targetPath;
          state.status = status;
          resetRepositoryViewState();
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
          const status = await window.api.initRepo(dir);
          state.repoPath = dir;
          state.status = status;
          resetRepositoryViewState();
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
    void refreshRuntimeIndicators();
  }

  // ═════════════════════════════════════════════════════════
  //  AUTOMATION STUDIO — VISUAL GIT MACROS
  // ═════════════════════════════════════════════════════════

  const AUTOMATION_BLOCKS = {
    stage_all: { icon: '＋', label: 'Stage all', tone: 'green' },
    commit: { icon: '●', label: 'Commit', tone: 'mauve' },
    fetch: { icon: '↓', label: 'Fetch', tone: 'blue' },
    pull: { icon: '⇣', label: 'Pull', tone: 'blue' },
    push: { icon: '⇡', label: 'Push', tone: 'orange' },
    checkout: { icon: '⑂', label: 'Checkout', tone: 'yellow' },
    merge: { icon: '⑂', label: 'Merge', tone: 'mauve' },
    guard: { icon: '◆', label: 'Requirement', tone: 'red' },
    condition: { icon: '◇', label: 'If / else', tone: 'yellow' }
  };
  const CONDITION_SOURCES = [
    ['commit_message', 'Commit message'],
    ['current_branch', 'Current branch'],
    ['start_branch', 'Starting branch']
  ];
  const CONDITION_OPERATORS = [
    ['equals', 'equals'],
    ['not_equals', 'does not equal'],
    ['contains', 'contains'],
    ['not_contains', 'does not contain'],
    ['starts_with', 'starts with'],
    ['ends_with', 'ends with']
  ];

  function localAutomationId(prefix = 'step') {
    const token = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now()}${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${token.slice(0, 16)}`;
  }

  function cloneAutomation(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function newAutomationStep(type) {
    const base = { id: localAutomationId(), type };
    if (type === 'commit') return { ...base, messageSource: 'prompt', message: '' };
    if (type === 'fetch') return { ...base, remote: 'origin', prune: true };
    if (type === 'pull') return { ...base, remote: 'origin', branch: '${currentBranch}', rebase: false };
    if (type === 'push') return { ...base, remote: 'origin', branch: '${currentBranch}', setUpstream: false };
    if (type === 'checkout') return { ...base, branch: 'main' };
    if (type === 'merge') return { ...base, branch: '${startBranch}', noFf: false };
    if (type === 'guard') return {
      ...base,
      condition: { source: 'current_branch', operator: 'equals', value: 'develop', caseSensitive: false },
      message: 'Run this macro from the develop branch.'
    };
    if (type === 'condition') return {
      ...base,
      condition: { source: 'commit_message', operator: 'contains', value: '[deploy]', caseSensitive: false },
      thenSteps: [newAutomationStep('push')],
      elseSteps: []
    };
    return base;
  }

  function newAutomationDraft() {
    return {
      name: 'New automation',
      description: '',
      enabled: true,
      scope: 'repository',
      trigger: { event: 'manual', condition: null },
      steps: [newAutomationStep('stage_all'), newAutomationStep('commit')]
    };
  }

  function automationNeedsCommitMessage(steps) {
    return (steps || []).some(step => (
      (step.type === 'commit' && step.messageSource !== 'template')
      || (step.type === 'condition' && (automationNeedsCommitMessage(step.thenSteps) || automationNeedsCommitMessage(step.elseSteps)))
    ));
  }

  function automationContainsStep(steps, type) {
    return (steps || []).some(step => step.type === type
      || (step.type === 'condition' && (automationContainsStep(step.thenSteps, type) || automationContainsStep(step.elseSteps, type))));
  }

  function countAutomationSteps(steps) {
    return (steps || []).reduce((count, step) => count + 1 + (step.type === 'condition'
      ? countAutomationSteps(step.thenSteps) + countAutomationSteps(step.elseSteps)
      : 0), 0);
  }

  function automationTriggerLabel(macro) {
    if (macro.trigger?.event === 'after_commit') {
      const condition = macro.trigger.condition;
      return condition ? `After commit · ${condition.source.replaceAll('_', ' ')} ${condition.operator.replaceAll('_', ' ')} “${condition.value}”` : 'After every commit';
    }
    return 'Manual';
  }

  function automationStepSummary(step) {
    const meta = AUTOMATION_BLOCKS[step.type] || { icon: '•', label: step.type };
    if (['pull', 'push', 'checkout', 'merge'].includes(step.type) && step.branch) return `${meta.label} ${step.branch}`;
    if (step.type === 'condition') return `${meta.label}: ${step.condition?.source?.replaceAll('_', ' ')} ${step.condition?.operator?.replaceAll('_', ' ')} “${step.condition?.value || ''}”`;
    if (step.type === 'guard') return `${meta.label}: ${step.condition?.value || ''}`;
    return meta.label;
  }

  async function showAutomationStudio() {
    if (!state.repoPath) return toast('Open a repository first', 'error');
    try {
      state.automations = await window.api.automations();
      const cards = state.automations.map((macro, index) => `
        <article class="automation-card ${macro.enabled ? '' : 'disabled'}">
          <div class="automation-card-icon">⚡</div>
          <div class="automation-card-main">
            <div class="automation-card-title">
              <strong>${escapeHtml(macro.name)}</strong>
              <span class="automation-badge ${macro.trigger?.event === 'after_commit' ? 'hook' : ''}">${escapeHtml(automationTriggerLabel(macro))}</span>
              <span class="automation-badge">${macro.scope === 'repository' ? 'This repository' : 'Global'}</span>
              ${macro.enabled ? '' : '<span class="automation-badge disabled">Disabled</span>'}
            </div>
            <p>${escapeHtml(macro.description || 'No description')}</p>
            <div class="automation-flow-mini">
              ${(macro.steps || []).map(step => `<span>${escapeHtml(automationStepSummary(step))}</span>`).join('<i>→</i>')}
            </div>
          </div>
          <div class="automation-card-actions">
            <button class="btn btn-small btn-primary automation-run" data-index="${index}" ${macro.enabled ? '' : 'disabled'}>▶ Run</button>
            <button class="btn btn-small automation-edit" data-index="${index}">Edit</button>
            <button class="btn btn-small automation-copy" data-index="${index}" title="Duplicate">⧉</button>
            <button class="btn btn-small btn-danger automation-delete" data-index="${index}" title="Delete">✕</button>
          </div>
        </article>
      `).join('');
      showModal('Automation Studio', `
        <div class="automation-hero">
          <div><span class="automation-hero-icon">⚡</span><strong>Turn repeatable Git work into one safe action.</strong><p>Build workflows from validated blocks. No shell commands, no hidden scripts.</p></div>
          <button id="automation-new" class="btn btn-primary">＋ New automation</button>
        </div>
        <div class="automation-list">${cards || '<div class="automation-empty">No automations yet.</div>'}</div>
      `, []);
      $('#modal').classList.add('modal-wide', 'modal-automation');
      $('#automation-new')?.addEventListener('click', () => showAutomationEditor());
      $$('.automation-run').forEach(button => button.addEventListener('click', () => showRunAutomationDialog(state.automations[Number(button.dataset.index)])));
      $$('.automation-edit').forEach(button => button.addEventListener('click', () => showAutomationEditor(state.automations[Number(button.dataset.index)])));
      $$('.automation-copy').forEach(button => button.addEventListener('click', async () => {
        const copy = cloneAutomation(state.automations[Number(button.dataset.index)]);
        delete copy.id;
        delete copy.createdAt;
        delete copy.updatedAt;
        copy.name = `${copy.name} copy`;
        renewAutomationStepIds(copy.steps);
        try { await window.api.saveAutomation(copy); toast('Automation duplicated', 'success'); await showAutomationStudio(); }
        catch (error) { toast(error.message, 'error'); }
      }));
      $$('.automation-delete').forEach(button => button.addEventListener('click', async () => {
        const macro = state.automations[Number(button.dataset.index)];
        if (!confirm(`Delete automation “${macro.name}”?`)) return;
        try { await window.api.removeAutomation(macro.id); toast('Automation deleted', 'info'); await showAutomationStudio(); }
        catch (error) { toast(error.message, 'error'); }
      }));
    } catch (error) {
      toast(`Could not load automations: ${error.message}`, 'error');
    }
  }

  function renewAutomationStepIds(steps) {
    (steps || []).forEach(step => {
      step.id = localAutomationId();
      if (step.type === 'condition') {
        renewAutomationStepIds(step.thenSteps);
        renewAutomationStepIds(step.elseSteps);
      }
    });
  }

  function renderAutomationRunPreview(steps, depth = 0) {
    return (steps || []).map(step => `
      <div class="automation-preview-step" style="--automation-depth:${depth}">
        <span class="automation-dot ${AUTOMATION_BLOCKS[step.type]?.tone || ''}"></span>
        <span>${escapeHtml(automationStepSummary(step))}</span>
      </div>
      ${step.type === 'condition' ? renderAutomationRunPreview(step.thenSteps, depth + 1) + renderAutomationRunPreview(step.elseSteps, depth + 1) : ''}
    `).join('');
  }

  function showRunAutomationDialog(macro) {
    if (!macro) return;
    const needsMessage = automationNeedsCommitMessage(macro.steps);
    showModal(`Run: ${macro.name}`, `
      <div class="automation-run-header">
        <span>Starting on</span><strong class="branch-pill">⑂ ${escapeHtml(state.branches?.current || state.status?.current || 'current branch')}</strong>
        <span>· ${countAutomationSteps(macro.steps)} blocks</span>
      </div>
      ${needsMessage ? `<div class="form-group"><label>Commit message</label><textarea id="automation-commit-message" rows="4" placeholder="Describe your changes..."></textarea></div>` : ''}
      <div class="automation-run-warning">The workflow stops immediately on an error or merge conflict. Completed network operations are not rolled back.</div>
      <div class="automation-preview">${renderAutomationRunPreview(macro.steps)}</div>
    `, [{
      label: '⚡ Run automation', primary: true, onClick: async () => {
        const commitMessage = $('#automation-commit-message')?.value.trim() || '';
        if (needsMessage && !commitMessage) return toast('Commit message is required', 'error');
        try {
          showLoading(`Starting ${macro.name}...`);
          const result = await window.api.runAutomation(macro.id, { commitMessage });
          if (commitMessage) addCommitHistory(commitMessage);
          await refresh();
          toast(`Automation completed on ${result.status?.current || 'the repository'}`, 'success');
          return true;
        } catch (error) {
          await refresh();
          toast(error.message, 'error');
          return false;
        } finally {
          hideLoading();
        }
      }
    }]);
    $('#modal').classList.add('modal-wide', 'modal-automation');
  }

  function optionList(options, selected) {
    return options.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  }

  function renderAutomationCondition(condition, stepId, prefix) {
    const safe = condition || { source: 'commit_message', operator: 'contains', value: '' };
    return `
      <div class="automation-condition-row">
        <span>IF</span>
        <select data-step-id="${stepId}" data-condition-prefix="${prefix}" data-condition-field="source">${optionList(CONDITION_SOURCES, safe.source)}</select>
        <select data-step-id="${stepId}" data-condition-prefix="${prefix}" data-condition-field="operator">${optionList(CONDITION_OPERATORS, safe.operator)}</select>
        <input data-step-id="${stepId}" data-condition-prefix="${prefix}" data-condition-field="value" value="${escapeHtml(safe.value || '')}" placeholder="value">
        <label class="checkbox-label compact"><input type="checkbox" data-step-id="${stepId}" data-condition-prefix="${prefix}" data-condition-field="caseSensitive" ${safe.caseSensitive ? 'checked' : ''}> Aa</label>
      </div>`;
  }

  function renderAutomationStepFields(step) {
    const field = (name, value, placeholder = '') => `<input data-step-id="${step.id}" data-step-field="${name}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}">`;
    if (step.type === 'commit') return `
      <div class="automation-fields two">
        <label>Message source<select data-step-id="${step.id}" data-step-field="messageSource"><option value="prompt" ${step.messageSource !== 'template' ? 'selected' : ''}>Ask when running</option><option value="template" ${step.messageSource === 'template' ? 'selected' : ''}>Fixed / template</option></select></label>
        ${step.messageSource === 'template' ? `<label>Message${field('message', step.message, 'release: ${startBranch}')}</label>` : '<div class="automation-field-note">A commit window will open before this macro starts.</div>'}
      </div>`;
    if (step.type === 'fetch') return `<div class="automation-fields two"><label>Remote (blank = all)${field('remote', step.remote, 'origin')}</label><label class="checkbox-label"><input type="checkbox" data-step-id="${step.id}" data-step-field="prune" ${step.prune !== false ? 'checked' : ''}> Prune deleted branches</label></div>`;
    if (step.type === 'pull') return `<div class="automation-fields three"><label>Remote${field('remote', step.remote, 'origin')}</label><label>Branch${field('branch', step.branch, '${currentBranch}')}</label><label class="checkbox-label"><input type="checkbox" data-step-id="${step.id}" data-step-field="rebase" ${step.rebase ? 'checked' : ''}> Rebase</label></div>`;
    if (step.type === 'push') return `<div class="automation-fields three"><label>Remote${field('remote', step.remote, 'origin')}</label><label>Branch${field('branch', step.branch, '${currentBranch}')}</label><label class="checkbox-label"><input type="checkbox" data-step-id="${step.id}" data-step-field="setUpstream" ${step.setUpstream ? 'checked' : ''}> Set upstream</label></div>`;
    if (step.type === 'checkout') return `<div class="automation-fields"><label>Branch${field('branch', step.branch, 'main')}</label></div>`;
    if (step.type === 'merge') return `<div class="automation-fields two"><label>Branch to merge${field('branch', step.branch, '${startBranch}')}</label><label class="checkbox-label"><input type="checkbox" data-step-id="${step.id}" data-step-field="noFf" ${step.noFf ? 'checked' : ''}> Always create merge commit (--no-ff)</label></div>`;
    if (step.type === 'guard') return `${renderAutomationCondition(step.condition, step.id, 'condition')}<div class="automation-fields"><label>Error message${field('message', step.message, 'Requirement not met')}</label></div>`;
    return '';
  }

  function renderAutomationSteps(steps, branchName = 'root', depth = 0) {
    if (!steps?.length) return '<div class="automation-lane-empty">Drop or add a block here</div>';
    return steps.map(step => {
      const meta = AUTOMATION_BLOCKS[step.type] || { icon: '•', label: step.type, tone: '' };
      return `
        <div class="automation-block tone-${meta.tone}" draggable="true" data-block-id="${step.id}">
          <div class="automation-block-header">
            <span class="automation-drag" title="Drag to reorder">⠿</span>
            <span class="automation-block-icon">${meta.icon}</span>
            <strong>${escapeHtml(meta.label)}</strong>
            <span class="automation-block-number">${depth ? branchName.toUpperCase() : 'FLOW'}</span>
            <div class="automation-block-actions">
              <button class="automation-step-up" data-step-id="${step.id}" title="Move up">↑</button>
              <button class="automation-step-down" data-step-id="${step.id}" title="Move down">↓</button>
              <button class="automation-step-copy" data-step-id="${step.id}" title="Duplicate">⧉</button>
              <button class="automation-step-remove" data-step-id="${step.id}" title="Remove">✕</button>
            </div>
          </div>
          <div class="automation-block-body">
            ${renderAutomationStepFields(step)}
            ${step.type === 'condition' ? `
              ${renderAutomationCondition(step.condition, step.id, 'condition')}
              <div class="automation-decision-grid">
                <div class="automation-lane then"><header><span>TRUE</span> Then</header><div class="automation-lane-flow">${renderAutomationSteps(step.thenSteps, 'then', depth + 1)}</div>${renderAutomationLaneAdd(step.id, 'thenSteps')}</div>
                <div class="automation-lane else"><header><span>FALSE</span> Otherwise</header><div class="automation-lane-flow">${renderAutomationSteps(step.elseSteps, 'else', depth + 1)}</div>${renderAutomationLaneAdd(step.id, 'elseSteps')}</div>
              </div>` : ''}
          </div>
        </div>`;
    }).join('<div class="automation-connector"><span>↓</span></div>');
  }

  function renderAutomationLaneAdd(parentId, branch) {
    return `<div class="automation-lane-add"><select data-lane-select="${parentId}:${branch}">${Object.entries(AUTOMATION_BLOCKS).map(([type, meta]) => `<option value="${type}">${meta.label}</option>`).join('')}</select><button class="btn btn-small automation-add-child" data-parent-id="${parentId}" data-branch="${branch}">＋ Add</button></div>`;
  }

  function findAutomationStep(steps, id) {
    for (const step of steps || []) {
      if (step.id === id) return step;
      if (step.type === 'condition') {
        const found = findAutomationStep(step.thenSteps, id) || findAutomationStep(step.elseSteps, id);
        if (found) return found;
      }
    }
    return null;
  }

  function findAutomationStepLocation(steps, id) {
    for (let index = 0; index < (steps || []).length; index += 1) {
      const step = steps[index];
      if (step.id === id) return { array: steps, index, step };
      if (step.type === 'condition') {
        const found = findAutomationStepLocation(step.thenSteps, id) || findAutomationStepLocation(step.elseSteps, id);
        if (found) return found;
      }
    }
    return null;
  }

  function showAutomationEditor(existing) {
    const draft = existing ? cloneAutomation(existing) : newAutomationDraft();
    const render = () => {
      const afterCommit = draft.trigger?.event === 'after_commit';
      const recursiveWarning = afterCommit && automationContainsStep(draft.steps, 'commit');
      showModal(existing ? `Edit: ${draft.name}` : 'New automation', `
        <div class="automation-editor">
          <aside class="automation-palette">
            <div class="automation-palette-title">BLOCK LIBRARY</div>
            ${Object.entries(AUTOMATION_BLOCKS).map(([type, meta]) => `<button class="automation-palette-block tone-${meta.tone}" data-add-step="${type}"><span>${meta.icon}</span><strong>${meta.label}</strong><small>＋</small></button>`).join('')}
            <div class="automation-variables"><strong>Variables</strong><code>\${startBranch}</code><code>\${currentBranch}</code><code>\${commitMessage}</code></div>
          </aside>
          <section class="automation-canvas">
            <div class="automation-editor-settings">
              <div class="automation-fields two"><label>Name<input data-macro-field="name" value="${escapeHtml(draft.name)}"></label><label>Description<input data-macro-field="description" value="${escapeHtml(draft.description || '')}" placeholder="What does this workflow do?"></label></div>
              <div class="automation-fields three">
                <label>Scope<select data-macro-field="scope"><option value="repository" ${draft.scope === 'repository' ? 'selected' : ''}>This repository</option><option value="global" ${draft.scope === 'global' ? 'selected' : ''}>All repositories</option></select></label>
                <label>Trigger<select data-macro-field="triggerEvent"><option value="manual" ${afterCommit ? '' : 'selected'}>Manual button</option><option value="after_commit" ${afterCommit ? 'selected' : ''}>Hook: after commit</option></select></label>
                <label class="checkbox-label automation-enabled"><input type="checkbox" data-macro-field="enabled" ${draft.enabled !== false ? 'checked' : ''}> Automation enabled</label>
              </div>
              ${afterCommit ? `<div class="automation-hook-settings"><strong>Hook filter</strong>${renderAutomationCondition(draft.trigger.condition || { source: 'commit_message', operator: 'contains', value: '[deploy]' }, '__trigger__', 'trigger')}</div><p class="automation-field-note">Runs after a successful commit created in KitsuneGIT. Leave the workflow free of Commit blocks.</p>` : ''}
              ${recursiveWarning ? '<div class="automation-validation-error">An after-commit hook cannot contain a Commit block.</div>' : ''}
            </div>
            <div class="automation-canvas-header"><div><strong>Workflow</strong><span>${countAutomationSteps(draft.steps)} blocks</span></div><small>Drag blocks or use ↑ ↓. Execution always follows the vertical line.</small></div>
            <div class="automation-flow" id="automation-flow">${renderAutomationSteps(draft.steps)}</div>
          </section>
        </div>
      `, [
        { label: 'Back', onClick: async () => { await showAutomationStudio(); return false; } },
        { label: 'Save automation', primary: true, onClick: async () => {
          try {
            const saved = await window.api.saveAutomation(draft);
            toast(`Automation “${saved.name}” saved`, 'success');
            await showAutomationStudio();
            return false;
          } catch (error) {
            toast(error.message, 'error');
            return false;
          }
        } }
      ]);
      $('#modal').classList.add('modal-wide', 'modal-automation-editor');
      bindAutomationEditor(draft, render);
    };
    render();
  }

  function bindAutomationEditor(draft, render) {
    const readControl = element => element.type === 'checkbox' ? element.checked : element.value;
    $$('[data-macro-field]').forEach(element => element.addEventListener('input', () => {
      const field = element.dataset.macroField;
      const value = readControl(element);
      if (field === 'triggerEvent') {
        draft.trigger = { event: value, condition: value === 'after_commit'
          ? (draft.trigger?.condition || { source: 'commit_message', operator: 'contains', value: '[deploy]', caseSensitive: false })
          : null };
        render();
      } else {
        draft[field] = value;
      }
    }));
    $$('[data-step-field]').forEach(element => element.addEventListener('input', () => {
      const step = findAutomationStep(draft.steps, element.dataset.stepId);
      if (!step) return;
      step[element.dataset.stepField] = readControl(element);
      if (element.dataset.stepField === 'messageSource' && element.tagName === 'SELECT') render();
    }));
    $$('[data-condition-field]').forEach(element => element.addEventListener('input', () => {
      const isTrigger = element.dataset.stepId === '__trigger__';
      const step = isTrigger ? null : findAutomationStep(draft.steps, element.dataset.stepId);
      const target = isTrigger ? draft.trigger.condition : step?.[element.dataset.conditionPrefix];
      if (target) target[element.dataset.conditionField] = readControl(element);
    }));
    $$('[data-add-step]').forEach(button => button.addEventListener('click', () => { draft.steps.push(newAutomationStep(button.dataset.addStep)); render(); }));
    $$('.automation-step-remove').forEach(button => button.addEventListener('click', () => {
      const location = findAutomationStepLocation(draft.steps, button.dataset.stepId);
      if (location) location.array.splice(location.index, 1);
      render();
    }));
    $$('.automation-step-copy').forEach(button => button.addEventListener('click', () => {
      const location = findAutomationStepLocation(draft.steps, button.dataset.stepId);
      if (!location) return;
      const copy = cloneAutomation(location.step);
      renewAutomationStepIds([copy]);
      location.array.splice(location.index + 1, 0, copy);
      render();
    }));
    $$('.automation-step-up, .automation-step-down').forEach(button => button.addEventListener('click', () => {
      const location = findAutomationStepLocation(draft.steps, button.dataset.stepId);
      if (!location) return;
      const delta = button.classList.contains('automation-step-up') ? -1 : 1;
      const target = location.index + delta;
      if (target < 0 || target >= location.array.length) return;
      [location.array[location.index], location.array[target]] = [location.array[target], location.array[location.index]];
      render();
    }));
    $$('.automation-add-child').forEach(button => button.addEventListener('click', () => {
      const parent = findAutomationStep(draft.steps, button.dataset.parentId);
      const select = $(`[data-lane-select="${button.dataset.parentId}:${button.dataset.branch}"]`);
      if (!parent || !select) return;
      parent[button.dataset.branch].push(newAutomationStep(select.value));
      render();
    }));

    let draggedId = null;
    $$('.automation-block[draggable="true"]').forEach(block => {
      block.addEventListener('dragstart', event => { draggedId = block.dataset.blockId; block.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
      block.addEventListener('dragend', () => { draggedId = null; block.classList.remove('dragging'); });
      block.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
      block.addEventListener('drop', event => {
        event.preventDefault();
        const targetId = block.dataset.blockId;
        if (!draggedId || draggedId === targetId) return;
        const source = findAutomationStepLocation(draft.steps, draggedId);
        const target = findAutomationStepLocation(draft.steps, targetId);
        if (!source || !target || source.array !== target.array) return toast('Drag reordering works inside the same lane', 'info');
        const [moved] = source.array.splice(source.index, 1);
        const nextTarget = source.array.findIndex(step => step.id === targetId);
        source.array.splice(nextTarget, 0, moved);
        render();
      });
    });
  }

  // ═════════════════════════════════════════════════════════
  //  SETTINGS DIALOG
  // ═════════════════════════════════════════════════════════

  async function showSettingsDialog() {
    let config = {};
    try { config = await window.api.getConfig(); } catch { /* empty config */ }
    const [runtime, runtimeSettings] = await Promise.all([
      window.api.runtimeStatus(state.repoPath),
      window.api.runtimeSettings(state.repoPath)
    ]);

    const fields = [
      { key: 'user.name', label: 'User Name' },
      { key: 'user.email', label: 'User Email' },
      { key: 'core.autocrlf', label: 'Auto CRLF' },
      { key: 'pull.rebase', label: 'Pull Rebase' },
      { key: 'push.default', label: 'Push Default' }
    ];

    const selectedMode = runtime.selection?.mode || runtimeSettings.mode || 'auto';
    const selectedCustomPath = runtime.selection?.customPath || runtimeSettings.customPath || '';
    const runtimeDetails = runtime.selected
      ? `<strong>${escapeHtml(runtimeLabel(runtime))}</strong><br><code>${escapeHtml(runtime.selected.binary)}</code>`
      : `<strong class="runtime-error">Git unavailable</strong><br>${escapeHtml(runtime.error || '')}`;
    const repositoryScope = Boolean(state.repoPath && runtimeSettings.repositoryOverride);

    const repositoryFields = state.repoPath ? `
      <div class="settings-section">
        <h4>Repository configuration</h4>
        ${fields.map(f => `
          <div class="form-group">
            <label>${f.label} <span style="color:var(--text-muted)">(${f.key})</span></label>
            <input id="cfg-${f.key.replace('.', '-')}" type="text" value="${escapeHtml(config[f.key] || '')}">
          </div>
        `).join('')}
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
      </div>
    ` : '';

    const html = `
      <div class="settings-section">
        <h4>Git Runtime</h4>
        <div class="runtime-card">${runtimeDetails}</div>
        <div class="form-group">
          <label>Runtime source</label>
          <select id="cfg-runtime-mode">
            <option value="auto" ${selectedMode === 'auto' ? 'selected' : ''}>Automatic (system, then managed fallback)</option>
            <option value="system" ${selectedMode === 'system' ? 'selected' : ''}>System Git only</option>
            <option value="managed" ${selectedMode === 'managed' ? 'selected' : ''}>Managed Git only</option>
            <option value="custom" ${selectedMode === 'custom' ? 'selected' : ''}>Custom executable</option>
          </select>
        </div>
        <div class="form-group">
          <label>Custom Git executable</label>
          <div class="input-row">
            <input id="cfg-runtime-path" type="text" value="${escapeHtml(selectedCustomPath)}" placeholder="Path to git or git.exe">
            <button id="cfg-runtime-browse" type="button" class="btn btn-small">Browse</button>
          </div>
        </div>
        ${state.repoPath ? `
          <div class="form-group">
            <label>Settings scope</label>
            <select id="cfg-runtime-scope">
              <option value="global" ${repositoryScope ? '' : 'selected'}>Global</option>
              <option value="repository" ${repositoryScope ? 'selected' : ''}>Only this repository</option>
            </select>
          </div>
        ` : ''}
        <div class="runtime-actions">
          ${runtime.managedInstallAvailable ? '<button id="cfg-runtime-install" type="button" class="btn btn-small">Install / repair managed Git</button>' : ''}
          ${repositoryScope ? '<button id="cfg-runtime-clear" type="button" class="btn btn-small">Remove repository override</button>' : ''}
        </div>
        <div id="runtime-progress" style="margin-top:10px;display:none">
          <div id="runtime-progress-text" style="margin-bottom:5px;color:var(--text-muted)">Preparing...</div>
          <div class="progress-track"><div id="runtime-progress-value" class="progress-value"></div></div>
        </div>
      </div>
      <div class="settings-section">
        <h4>Authentication</h4>
        <p style="color:var(--text-muted);margin-bottom:8px">Manage HTTPS credentials, SSH keys, agents, and trusted hosts without storing private secrets in KitsuneGIT.</p>
        <button id="cfg-auth-open" type="button" class="btn btn-small">Open credentials and SSH manager</button>
        <button id="cfg-diagnostics-open" type="button" class="btn btn-small">Run system diagnostics</button>
      </div>
      ${repositoryFields}
    `;

    showModal('Repository Settings', html, [{
      label: 'Save', primary: true, onClick: async () => {
        try {
          const mode = document.getElementById('cfg-runtime-mode').value;
          const customPath = document.getElementById('cfg-runtime-path').value.trim();
          const scope = document.getElementById('cfg-runtime-scope')?.value || 'global';
          const result = await window.api.setRuntimeSettings({ mode, customPath, scope }, state.repoPath);
          state.runtime = result.runtime;
          if (result.repositoryStatus) state.status = result.repositoryStatus;
          if (state.repoPath) {
            for (const f of fields) {
              const input = document.getElementById(`cfg-${f.key.replace('.', '-')}`);
              const val = input.value.trim();
              if (val && val !== (config[f.key] || '')) {
                await window.api.setConfig(f.key, val);
              }
            }
            const afVal = parseInt(document.getElementById('cfg-autofetch').value, 10) || 0;
            setAutoFetch(afVal);
          }
          await refreshRuntimeIndicators();
          if (state.repoPath) await refresh();
          toast('Settings saved', 'success');
        } catch (err) { toast(err.message, 'error'); }
      }
    }]);

    setTimeout(() => {
      $('#cfg-runtime-browse')?.addEventListener('click', async () => {
        const executable = await window.api.openGitExecutable();
        if (executable) {
          $('#cfg-runtime-path').value = executable;
          $('#cfg-runtime-mode').value = 'custom';
        }
      });
      $('#cfg-runtime-install')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        $('#runtime-progress').style.display = '';
        try {
          const result = await window.api.installManagedRuntime();
          state.runtime = result.runtime;
          if (result.repositoryStatus) state.status = result.repositoryStatus;
          await refreshRuntimeIndicators();
          toast('Managed Git installed and verified', 'success');
          await showSettingsDialog();
        } catch (error) {
          toast(`Managed Git installation failed: ${error.message}`, 'error');
          button.disabled = false;
        }
      });
      $('#cfg-runtime-clear')?.addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        try {
          const result = await window.api.clearRuntimeOverride(state.repoPath);
          state.runtime = result.runtime;
          if (result.repositoryStatus) state.status = result.repositoryStatus;
          await refreshRuntimeIndicators();
          toast('Repository runtime override removed', 'success');
          await showSettingsDialog();
        } catch (error) {
          toast(error.message, 'error');
          event.currentTarget.disabled = false;
        }
      });
      $('#cfg-auth-open')?.addEventListener('click', showAuthenticationDialog);
      $('#cfg-diagnostics-open')?.addEventListener('click', showDiagnosticsDialog);
    });
  }

  async function showDiagnosticsDialog() {
    showLoading('Running environment diagnostics...');
    try {
      const report = await window.api.runDiagnostics(state.repoPath);
      renderDiagnosticsDialog(report);
    } catch (error) {
      toast(`Diagnostics failed: ${error.message}`, 'error');
    } finally {
      hideLoading();
    }
  }

  function renderDiagnosticsDialog(report) {
    const rows = report.checks.map((item, index) => `
      <div class="diagnostic-row ${item.status}" data-diagnostic-index="${index}">
        <span class="diagnostic-icon">${item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '×'}</span>
        <div class="diagnostic-content">
          <strong>${escapeHtml(item.label)}</strong>
          <div>${escapeHtml(item.detail)}</div>
        </div>
        ${item.fixable ? '<button class="btn btn-small diagnostic-fix">Fix</button>' : ''}
      </div>
    `).join('');
    const html = `
      <div class="diagnostic-summary">
        <span class="runtime-ok">${report.summary.pass} passed</span>
        <span class="diagnostic-warn">${report.summary.warn} warnings</span>
        <span class="runtime-error">${report.summary.fail} failed</span>
      </div>
      <div class="diagnostic-list">${rows}</div>
      <p style="margin-top:10px;color:var(--text-muted);font-size:11px">Exported reports redact credentials embedded in HTTPS remote URLs and never contain private keys or process environments.</p>`;
    showModal('KitsuneGIT System Check', html, [
      { label: 'Export report', onClick: async () => {
        const exported = await window.api.exportDiagnostics(state.repoPath);
        if (exported) toast(`Diagnostics exported to ${exported}`, 'success');
        return false;
      } },
      { label: 'Run again', primary: true, onClick: async () => { await showDiagnosticsDialog(); return false; } }
    ]);
    setTimeout(() => {
      $$('.diagnostic-row').forEach(row => {
        const item = report.checks[Number(row.dataset.diagnosticIndex)];
        row.querySelector('.diagnostic-fix')?.addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          try {
            const nextReport = await window.api.fixDiagnostic(item.id, state.repoPath);
            await refreshRuntimeIndicators();
            renderDiagnosticsDialog(nextReport);
            toast(`${item.label} fixed`, 'success');
          } catch (error) {
            toast(`Automatic fix failed: ${error.message}`, 'error');
            event.currentTarget.disabled = false;
          }
        });
      });
    });
  }

  async function showAuthenticationDialog() {
    let auth;
    try {
      auth = await window.api.authStatus(state.repoPath);
    } catch (error) {
      toast(`Authentication diagnostics failed: ${error.message}`, 'error');
      return;
    }
    const agentFingerprints = new Set((auth.ssh.agent.keys || []).map(key => key.fingerprint));
    const keyRows = auth.ssh.keys.length ? auth.ssh.keys.map((key, index) => {
      const loaded = key.fingerprint && agentFingerprints.has(key.fingerprint);
      const selected = auth.ssh.selectedKey === key.path;
      return `
        <div class="credential-row" data-key-index="${index}">
          <div class="credential-main">
            <strong>${escapeHtml(key.name)}</strong>
            ${selected ? '<span class="credential-badge">repository</span>' : ''}
            ${loaded ? '<span class="credential-badge success">agent</span>' : ''}
            <div class="credential-detail">${escapeHtml(key.algorithm || 'unknown')} · ${escapeHtml(key.fingerprint || 'no public fingerprint')}</div>
            <code>${escapeHtml(key.path)}</code>
          </div>
          <div class="credential-actions">
            ${state.repoPath ? `<button class="btn btn-small auth-key-select">${selected ? 'Clear selection' : 'Use for repository'}</button>` : ''}
            <button class="btn btn-small auth-key-agent">${loaded ? 'Unload' : 'Load in agent'}</button>
            ${key.publicPath ? '<button class="btn btn-small auth-key-copy">Copy public key</button>' : ''}
            <button class="btn btn-small ${key.managedLocation ? 'btn-danger auth-key-delete' : 'auth-key-unlink'}">${key.managedLocation ? 'Delete' : 'Unlink'}</button>
          </div>
        </div>`;
    }).join('') : '<div class="empty-inline">No SSH private keys with public metadata were found.</div>';
    const allowedStores = auth.gcm.allowedStores.map(store => (
      `<option value="${escapeHtml(store)}" ${store === auth.gcm.store ? 'selected' : ''}>${escapeHtml(store)}</option>`
    )).join('');

    const html = `
      <div class="settings-section">
        <h4>HTTPS credentials</h4>
        <div class="runtime-card">
          <strong>Git Credential Manager:</strong> ${auth.gcm.available ? `<span class="runtime-ok">${escapeHtml(auth.gcm.version)}</span>` : '<span class="runtime-error">not available</span>'}<br>
          <strong>Credential helpers:</strong> ${escapeHtml(auth.gcm.helpers.join(', ') || 'none')}
        </div>
        <div class="input-row">
          <select id="auth-gcm-store" ${auth.gcm.available ? '' : 'disabled'}>${allowedStores}</select>
          <button id="auth-gcm-configure" class="btn btn-small" ${auth.gcm.available ? '' : 'disabled'}>Configure GCM</button>
        </div>
        <div class="input-row" style="margin-top:8px">
          <input id="auth-https-host" type="text" placeholder="github.com">
          <button id="auth-https-erase" class="btn btn-small btn-danger">Forget HTTPS credential</button>
        </div>
      </div>
      <div class="settings-section">
        <h4>SSH keys</h4>
        <div class="runtime-card">
          <strong>OpenSSH:</strong> ${auth.ssh.executable ? `<span class="runtime-ok">available</span>` : '<span class="runtime-error">not found</span>'}<br>
          <strong>Agent:</strong> ${auth.ssh.agent.available ? `<span class="runtime-ok">running (${auth.ssh.agent.keys.length} identities)</span>` : `<span class="runtime-error">${escapeHtml(auth.ssh.agent.error || 'not running')}</span>`}
        </div>
        <div class="credential-list">${keyRows}</div>
        <div class="runtime-actions">
          <button id="auth-key-import" class="btn btn-small">Import key reference</button>
          <button id="auth-key-refresh" class="btn btn-small">Refresh</button>
        </div>
        <div class="form-grid" style="margin-top:12px">
          <div class="form-group"><label>New key name</label><input id="auth-key-name" value="id_ed25519_kitsune"></div>
          <div class="form-group"><label>Comment / email</label><input id="auth-key-comment" value="${escapeHtml(configuredCommitEmail())}" placeholder="name@example.com"></div>
        </div>
        <button id="auth-key-generate" class="btn btn-small">Generate protected Ed25519 key in terminal</button>
      </div>
      <div class="settings-section">
        <h4>SSH host trust and connection test</h4>
        <div class="form-grid three">
          <div class="form-group"><label>Host</label><input id="auth-ssh-host" value="github.com"></div>
          <div class="form-group"><label>Port</label><input id="auth-ssh-port" type="number" min="1" max="65535" value="22"></div>
          <div class="form-group"><label>User</label><input id="auth-ssh-user" value="git"></div>
        </div>
        <div class="runtime-actions">
          <button id="auth-host-scan" class="btn btn-small">Scan host fingerprints</button>
          <button id="auth-host-test" class="btn btn-small">Test SSH connection</button>
        </div>
      </div>`;

    showModal('Credentials and SSH Manager', html, [{ label: 'Done', primary: true, onClick: () => true }]);
    setTimeout(() => bindAuthenticationActions(auth));
  }

  function configuredCommitEmail() {
    const input = $('#cfg-user-email');
    return input?.value?.trim() || 'kitsune@example.com';
  }

  function bindAuthenticationActions(auth) {
    $('#auth-gcm-configure')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        await window.api.configureGcm($('#auth-gcm-store').value, state.repoPath);
        toast('Git Credential Manager configured', 'success');
        await showAuthenticationDialog();
      } catch (error) { toast(error.message, 'error'); event.currentTarget.disabled = false; }
    });
    $('#auth-https-erase')?.addEventListener('click', async event => {
      const host = $('#auth-https-host').value.trim();
      if (!host || !confirm(`Forget the stored HTTPS credential for ${host}?`)) return;
      event.currentTarget.disabled = true;
      try {
        await window.api.eraseHttpsCredential(host, state.repoPath);
        toast(`Credential for ${host} removed`, 'success');
      } catch (error) { toast(error.message, 'error'); }
      finally { event.currentTarget.disabled = false; }
    });
    $('#auth-key-import')?.addEventListener('click', async () => {
      const keyPath = await window.api.openSshKey();
      if (!keyPath) return;
      try { await window.api.importSshKey(keyPath); await showAuthenticationDialog(); }
      catch (error) { toast(error.message, 'error'); }
    });
    $('#auth-key-refresh')?.addEventListener('click', showAuthenticationDialog);
    $('#auth-key-generate')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        await window.api.generateSshKey({ name: $('#auth-key-name').value.trim(), comment: $('#auth-key-comment').value.trim() }, state.repoPath);
        toast('ssh-keygen opened in a terminal. Use a strong passphrase, then refresh the key list.', 'info');
      } catch (error) { toast(error.message, 'error'); }
      finally { event.currentTarget.disabled = false; }
    });
    $$('.credential-row').forEach(row => {
      const key = auth.ssh.keys[Number(row.dataset.keyIndex)];
      const selected = auth.ssh.selectedKey === key.path;
      const loaded = key.fingerprint && auth.ssh.agent.keys.some(agentKey => agentKey.fingerprint === key.fingerprint);
      row.querySelector('.auth-key-select')?.addEventListener('click', async () => {
        try { await window.api.setRepositorySshKey(selected ? null : key.path, state.repoPath); await showAuthenticationDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      row.querySelector('.auth-key-agent')?.addEventListener('click', async () => {
        try {
          if (loaded) await window.api.removeSshKeyFromAgent(key.path, state.repoPath);
          else await window.api.addSshKeyToAgent(key.path, state.repoPath);
          toast(loaded ? 'Key unloaded from SSH agent' : 'ssh-add opened in a terminal', 'info');
          if (loaded) await showAuthenticationDialog();
        } catch (error) { toast(error.message, 'error'); }
      });
      row.querySelector('.auth-key-copy')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(await window.api.readSshPublicKey(key.path));
          toast('Public key copied', 'success');
        } catch (error) { toast(error.message, 'error'); }
      });
      row.querySelector('.auth-key-unlink')?.addEventListener('click', async () => {
        try { await window.api.removeImportedSshKey(key.path); await showAuthenticationDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      row.querySelector('.auth-key-delete')?.addEventListener('click', async () => {
        if (!confirm(`Permanently delete ${key.name} and its public key? This cannot be undone.`)) return;
        try { await window.api.deleteSshKey(key.path); await showAuthenticationDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
    });
    $('#auth-host-scan')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        const scan = await window.api.scanSshHost($('#auth-ssh-host').value.trim(), Number($('#auth-ssh-port').value), state.repoPath);
        const fingerprints = scan.keys.map(key => `<li><code>${escapeHtml(key.algorithm || '')} ${escapeHtml(key.fingerprint || 'unknown')}</code></li>`).join('');
        showModal(`Verify ${scan.host}`, `<p>Compare these fingerprints with a trusted source before continuing:</p><ul class="fingerprint-list">${fingerprints}</ul>`, [{
          label: 'Trust these keys', primary: true, onClick: async () => {
            const count = await window.api.trustSshHost(scan);
            toast(`${count} host key(s) added to known_hosts`, 'success');
          }
        }]);
      } catch (error) { toast(error.message, 'error'); event.currentTarget.disabled = false; }
    });
    $('#auth-host-test')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        const result = await window.api.testSshConnection(
          $('#auth-ssh-host').value.trim(), Number($('#auth-ssh-port').value), $('#auth-ssh-user').value.trim(), state.repoPath
        );
        toast(result.success ? `SSH connection succeeded: ${result.output}` : `SSH connection failed: ${result.output}`, result.success ? 'success' : 'error');
      } catch (error) { toast(error.message, 'error'); }
      finally { event.currentTarget.disabled = false; }
    });
  }

  // ═════════════════════════════════════════════════════════
  //  REFRESH / LOAD DATA
  // ═════════════════════════════════════════════════════════

  let refreshPromise = null;
  let refreshAgain = false;

  async function refresh() {
    if (!state.repoPath) return;
    if (refreshPromise) {
      refreshAgain = true;
      return refreshPromise;
    }
    const requestedRepo = state.repoPath;
    refreshPromise = performRefresh(requestedRepo);
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh();
      }
    }
  }

  async function performRefresh(requestedRepo) {
    try {
      setStatus('Refreshing...');
      const results = await Promise.all([
        window.api.status(), window.api.branches(), window.api.tags(),
        window.api.stashList().catch(() => []), window.api.remotes().catch(() => []),
        window.api.submodules().catch(() => []), window.api.diffStats().catch(() => []),
        window.api.diffStatsCached().catch(() => []), window.api.gitflowBranches().catch(() => null),
        window.api.operationState().catch(() => null)
      ]);
      if (requestedRepo !== state.repoPath) return;
      [
        state.status, state.branches, state.tags, state.stashes, state.remotes,
        state.submodules, state.diffStats, state.diffStatsCached, state.gitflow, state.operation
      ] = results;

      const hasConflicts = (state.status.conflicted?.length || 0) > 0;
      state.isRebaseInProgress = state.operation?.type === 'rebase';
      const rebaseBar = $('#rebase-conflict-bar');
      if (rebaseBar) rebaseBar.style.display = hasConflicts || state.operation?.inProgress ? 'flex' : 'none';
      const operationLabel = $('#operation-state-label');
      if (operationLabel) {
        const operationName = state.operation?.type ? state.operation.type.replace('-', ' ') : 'conflict';
        operationLabel.textContent = `⚠ ${operationName} ${state.operation?.inProgress ? 'in progress' : 'requires attention'}${hasConflicts ? ` — ${state.status.conflicted.length} conflict(s)` : ''}`;
      }
      const resolveButton = $('#btn-resolve-conflicts');
      if (resolveButton) resolveButton.style.display = hasConflicts ? '' : 'none';

      renderStatusBar();
      renderToolbar();
      renderSidebar();
      renderFileStatus();

      if (state.currentView === 'history') await loadLog();
      setStatus('Ready');
    } catch (err) {
      if (requestedRepo !== state.repoPath) return;
      setStatus('Error: ' + err.message);
      toast('Refresh failed: ' + err.message, 'error');
    }
  }

  async function loadLog() {
    const requestedRepo = state.repoPath;
    try {
      const log = await window.api.log(500);
      if (requestedRepo !== state.repoPath) return;
      state.log = log;
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
      ? `⬆ ${t('push')}${ahead > 0 ? ' <span class="toolbar-badge">↑' + ahead + '</span>' : ''}`
      : `⬆ ${t('push')}`;
    pullBtn.innerHTML = behind > 0 || ahead > 0
      ? `⬇ ${t('pull')}${behind > 0 ? ' <span class="toolbar-badge">↓' + behind + '</span>' : ''}`
      : `⬇ ${t('pull')}`;

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
    $('#statusbar-branch').textContent = `${t('branchLabel')}: ${state.status.current || 'detached'}`;
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
      menuItems.push({ label: 'Open in Editor', onClick: () => window.api.openFileInEditor(file.path) });
      menuItems.push({ label: 'Reveal in File Explorer', onClick: () => window.api.showItemInFolder(file.path) });
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
      if (zone.dataset.dropHandlersBound === 'true') return;
      zone.dataset.dropHandlersBound = 'true';
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
    const requestedRepo = state.repoPath;
    try {
      const diff = cached
        ? await window.api.diffCached(filePath)
        : await window.api.diff(filePath);
      if (requestedRepo !== state.repoPath || state.selectedFile !== filePath) return;
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
    let oldLine = 0, newLine = 0, hunkIndex = -1, hunkLineIndex = 0;

    // Collect lines for word-level highlighting
    const parsed = [];
    lines.forEach((line, sourceIndex) => {
      if (sourceIndex === lines.length - 1 && line === '') return;
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (match) { oldLine = parseInt(match[1]); newLine = parseInt(match[2]); }
        hunkIndex += 1;
        hunkLineIndex = 0;
        parsed.push({ type: 'hunk', oldNum: '···', newNum: '···', content: line, hunkIndex });
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        parsed.push({ type: 'added', oldNum: '', newNum: newLine++, content: line.substring(1), hunkIndex, hunkLineIndex: hunkLineIndex++ });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        parsed.push({ type: 'removed', oldNum: oldLine++, newNum: '', content: line.substring(1), hunkIndex, hunkLineIndex: hunkLineIndex++ });
      } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        parsed.push({ type: 'meta', oldNum: '', newNum: '', content: line });
      } else if (line.startsWith('\\')) {
        parsed.push({ type: 'marker', oldNum: '', newNum: '', content: line, hunkIndex, hunkLineIndex: hunkLineIndex++ });
      } else {
        parsed.push({ type: 'context', oldNum: oldLine++, newNum: newLine++, content: line.startsWith(' ') ? line.substring(1) : line, hunkIndex, hunkLineIndex: hunkLineIndex++ });
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
              container.appendChild(makeDiffLineEl(remLine.oldNum, remLine.newNum, remHtml, 'removed', true, remLine));
              container.appendChild(makeDiffLineEl(addLine.oldNum, addLine.newNum, addHtml, 'added', true, addLine));
            } else if (remLine) {
              container.appendChild(makeDiffLineEl(remLine.oldNum, remLine.newNum, escapeHtml(remLine.content), 'removed', true, remLine));
            } else if (addLine) {
              container.appendChild(makeDiffLineEl(addLine.oldNum, addLine.newNum, escapeHtml(addLine.content), 'added', true, addLine));
            }
          }
          i = addEnd;
          continue;
        } else {
          // No matching adds — render removed lines normally
          for (let j = remStart; j <= remEnd; j++) {
            container.appendChild(makeDiffLineEl(parsed[j].oldNum, parsed[j].newNum, escapeHtml(parsed[j].content), 'removed', true, parsed[j]));
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
      if (p.type === 'hunk') appendHunkActions(lineEl, p.hunkIndex);
      decorateSelectableDiffLine(lineEl, p);
      container.appendChild(lineEl);
    }
    updateDiffSelectionControls();
  }

  function makeDiffLineEl(oldNum, newNum, contentHtml, cls, isHtml, parsedLine) {
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
    decorateSelectableDiffLine(lineEl, parsedLine);
    return lineEl;
  }

  function decorateSelectableDiffLine(lineElement, parsedLine) {
    if (!parsedLine || !['added', 'removed'].includes(parsedLine.type) || parsedLine.hunkIndex < 0) return;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'diff-line-select';
    checkbox.dataset.hunk = String(parsedLine.hunkIndex);
    checkbox.dataset.line = String(parsedLine.hunkLineIndex);
    checkbox.title = 'Select this changed line';
    checkbox.setAttribute('aria-label', `Select ${parsedLine.type} line`);
    checkbox.addEventListener('change', () => lineElement.classList.toggle('diff-selected', checkbox.checked));
    lineElement.insertBefore(checkbox, lineElement.querySelector('.diff-line-content'));
  }

  function appendHunkActions(lineElement, hunkIndex) {
    const actions = document.createElement('span');
    actions.className = 'diff-hunk-actions';
    const primary = document.createElement('button');
    primary.className = 'btn btn-small';
    primary.textContent = state.lastDiffCached ? 'Unstage hunk' : 'Stage hunk';
    primary.addEventListener('click', event => {
      event.stopPropagation();
      void applyDiffSelection([{ hunk: hunkIndex }], state.lastDiffCached ? 'unstage' : 'stage');
    });
    actions.appendChild(primary);
    if (!state.lastDiffCached) {
      const discard = document.createElement('button');
      discard.className = 'btn btn-small btn-danger';
      discard.textContent = 'Discard hunk';
      discard.addEventListener('click', event => {
        event.stopPropagation();
        void applyDiffSelection([{ hunk: hunkIndex }], 'discard');
      });
      actions.appendChild(discard);
    }
    lineElement.appendChild(actions);
  }

  function selectedDiffLines() {
    const grouped = new Map();
    $$('.diff-line-select:checked').forEach(checkbox => {
      const hunk = Number(checkbox.dataset.hunk);
      const line = Number(checkbox.dataset.line);
      if (!grouped.has(hunk)) grouped.set(hunk, []);
      grouped.get(hunk).push(line);
    });
    return [...grouped.entries()].map(([hunk, lines]) => ({ hunk, lines }));
  }

  function updateDiffSelectionControls() {
    const inline = state.diffMode === 'inline' && Boolean(state.lastDiffFile) && Boolean(state.lastDiffText);
    const applyButton = $('#btn-apply-selected-lines');
    const discardButton = $('#btn-discard-selected-lines');
    applyButton.style.display = inline ? '' : 'none';
    applyButton.textContent = state.lastDiffCached ? 'Unstage selected lines' : 'Stage selected lines';
    discardButton.style.display = inline && !state.lastDiffCached ? '' : 'none';
  }

  async function applyDiffSelection(selection, action) {
    if (!state.lastDiffFile) return toast('Select a changed file first', 'info');
    if (!selection.length) return toast('Select at least one changed line', 'info');
    if (action === 'discard' && !confirm('Discard the selected changes from the working tree? This cannot be undone.')) return;
    const filePath = state.lastDiffFile;
    const cached = state.lastDiffCached;
    try {
      showLoading(`${action === 'stage' ? 'Staging' : action === 'unstage' ? 'Unstaging' : 'Discarding'} selected changes...`);
      await window.api.applySelection(filePath, selection, action);
      await refresh();
      if (state.repoPath && state.selectedFile === filePath) await showDiff(filePath, action === 'stage' ? false : cached);
      toast('Selected changes applied', 'success');
    } catch (error) {
      toast(`Could not apply selected changes: ${error.message}`, 'error');
    } finally {
      hideLoading();
    }
  }

  function wordDiffHighlight(oldStr, newStr) {
    // Simple word-level diff
    const oldWords = oldStr.split(/(\s+)/);
    const newWords = newStr.split(/(\s+)/);
    if (oldStr.length + newStr.length > 20_000 || oldWords.length > 1000 || newWords.length > 1000) {
      return [escapeHtml(oldStr), escapeHtml(newStr)];
    }
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

  async function showConflictCenter() {
    try {
      const operation = await window.api.operationState();
      const conflicts = operation.conflicted || [];
      const html = conflicts.length
        ? `<p style="margin-bottom:10px">Resolve and stage every file before continuing ${escapeHtml(operation.type || 'the operation')}.</p>
           <div class="conflict-list">${conflicts.map((file, index) => `
             <button class="conflict-file" data-conflict-index="${index}"><span>⚠</span><code>${escapeHtml(file.path)}</code><span>Open →</span></button>
           `).join('')}</div>`
        : '<div class="empty-inline">No unresolved files remain. You can continue the operation.</div>';
      showModal('Conflict Center', html, [
        { label: 'Continue operation', primary: true, onClick: async () => {
          await window.api.continueOperation();
          await refresh();
          toast('Git operation continued', 'success');
        } }
      ]);
      setTimeout(() => {
        $$('.conflict-file').forEach(button => button.addEventListener('click', () => {
          void showConflictFile(conflicts[Number(button.dataset.conflictIndex)].path);
        }));
      });
    } catch (error) {
      toast(`Could not load conflicts: ${error.message}`, 'error');
    }
  }

  async function showConflictFile(filePath) {
    showLoading('Loading conflict stages...');
    try {
      const conflict = await window.api.conflictFile(filePath);
      const binaryMessage = conflict.binary
        ? '<div class="runtime-card runtime-error">This is a binary conflict. Select one complete side or resolve it in an external editor.</div>'
        : `
          <div class="conflict-panes">
            <label>Base<textarea readonly>${escapeHtml(conflict.base || '')}</textarea></label>
            <label>Ours<textarea readonly>${escapeHtml(conflict.ours || '')}</textarea></label>
            <label>Theirs<textarea readonly>${escapeHtml(conflict.theirs || '')}</textarea></label>
          </div>
          <label class="conflict-result">Resolved result<textarea id="conflict-result-text">${escapeHtml(conflict.current || '')}</textarea></label>`;
      showModal(`Resolve: ${filePath}`, binaryMessage, [
        { label: 'Use ours', onClick: async () => {
          await window.api.resolveConflictUsing(filePath, 'ours');
          await refresh();
          toast(`${filePath} resolved using ours`, 'success');
          await showConflictCenter();
        } },
        { label: 'Use theirs', onClick: async () => {
          await window.api.resolveConflictUsing(filePath, 'theirs');
          await refresh();
          toast(`${filePath} resolved using theirs`, 'success');
          await showConflictCenter();
        } },
        ...(!conflict.binary ? [{ label: 'Save and stage', primary: true, onClick: async () => {
          await window.api.saveConflictResolution(filePath, $('#conflict-result-text').value);
          await refresh();
          toast(`${filePath} resolved and staged`, 'success');
          await showConflictCenter();
        } }] : [])
      ]);
      $('#modal').classList.add('modal-wide');
    } catch (error) {
      toast(`Could not open conflict: ${error.message}`, 'error');
    } finally {
      hideLoading();
    }
  }

  // Operation continue / abort wiring
  $('#btn-resolve-conflicts')?.addEventListener('click', showConflictCenter);
  $('#btn-rebase-continue')?.addEventListener('click', async () => {
    try {
      showLoading('Continuing Git operation...');
      await window.api.continueOperation();
      await refresh();
      toast('Git operation continued', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  });
  $('#btn-rebase-abort')?.addEventListener('click', async () => {
    if (!confirm('Abort the current Git operation and return to its previous state?')) return;
    try {
      showLoading('Aborting Git operation...');
      await window.api.abortOperation();
      await refresh();
      toast('Git operation aborted', 'info');
    } catch (err) { toast(err.message, 'error'); }
    finally { hideLoading(); }
  });

  async function showAdvancedToolsDialog() {
    if (!state.repoPath) return toast('Open a repository first', 'error');
    showLoading('Loading repository tools...');
    try {
      const [worktrees, bisect, lfs, sparse, maintenance, providerStatus, providerRepository, profiles, overview] = await Promise.all([
        window.api.worktrees(),
        window.api.bisectStatus(),
        window.api.lfsStatus(),
        window.api.sparseStatus(),
        window.api.maintenanceStatus(),
        window.api.providerStatus(),
        window.api.detectProviderRepository(),
        window.api.profiles(),
        window.api.repositoryOverview()
      ]);
      const worktreeRows = worktrees.map((item, index) => `
        <div class="tool-list-row">
          <div><strong>${escapeHtml(item.branch || '(detached)')}</strong><code>${escapeHtml(item.path)}</code></div>
          <div class="credential-actions">
            <button class="btn btn-small tool-worktree-open" data-index="${index}">Open</button>
            ${pathEquals(item.path, state.repoPath) ? '' : `<button class="btn btn-small btn-danger tool-worktree-remove" data-index="${index}">Remove</button>`}
          </div>
        </div>`).join('');
      const lfsPatterns = lfs.trackedPatterns?.length ? lfs.trackedPatterns.map(escapeHtml).join(', ') : 'none';
      showModal('Advanced Repository Tools', `
        <div class="tool-grid">
          <section class="tool-card tool-card-wide repository-overview">
            <div><strong>${overview.commits}</strong><span>commits</span></div>
            <div><strong>${state.branches?.local?.length || 0}</strong><span>local branches</span></div>
            <div><strong>${state.remotes?.length || 0}</strong><span>remotes</span></div>
            <div><strong>${escapeHtml(overview.objects['size-pack'] || '0 bytes')}</strong><span>packed objects</span></div>
            <div><strong>${overview.contributors.length}</strong><span>top contributors found</span></div>
          </section>
          <section class="tool-card tool-card-wide">
            <h4>Worktrees <span class="credential-badge">${worktrees.length}</span></h4>
            <p>Work on several branches simultaneously without extra clones.</p>
            <div class="tool-list">${worktreeRows || '<div class="empty-inline">No worktrees</div>'}</div>
            <div class="form-grid three tool-form">
              <input id="tool-worktree-path" placeholder="Target directory">
              <input id="tool-worktree-branch" placeholder="Existing branch">
              <input id="tool-worktree-new-branch" placeholder="Or new branch">
            </div>
            <div class="runtime-actions">
              <button id="tool-worktree-add" class="btn btn-primary btn-small">Add worktree</button>
              <button id="tool-worktree-prune" class="btn btn-small">Prune stale metadata</button>
            </div>
          </section>

          <section class="tool-card">
            <h4>Reflog & recovery</h4>
            <p>Inspect recent reference movements and restore a commit to a new branch.</p>
            <button id="tool-reflog" class="btn btn-small">Open reflog</button>
          </section>

          <section class="tool-card">
            <h4>Interactive rebase</h4>
            <p>Reorder, reword, squash, fixup, or drop local commits. A recovery ref is created before history is rewritten.</p>
            <input id="tool-rebase-upstream" placeholder="Upstream branch, e.g. main">
            <button id="tool-rebase-plan" class="btn btn-small">Build rebase plan</button>
          </section>

          <section class="tool-card">
            <h4>Patch exchange</h4>
            <p>Export one commit as a portable mailbox patch or import it with a 3-way fallback.</p>
            <input id="tool-patch-hash" value="${escapeHtml(state.selectedCommit || state.log[0]?.hash || '')}" placeholder="Commit hash">
            <div class="runtime-actions">
              <button id="tool-patch-export" class="btn btn-small">Export .patch</button>
              <button id="tool-patch-import" class="btn btn-small">Import .patch</button>
            </div>
          </section>

          <section class="tool-card">
            <h4>Bisect ${bisect.active ? '<span class="credential-badge success">active</span>' : ''}</h4>
            ${bisect.active ? `
              <p>Current: <code>${escapeHtml(bisect.current?.slice(0, 12))}</code></p>
              <div class="runtime-actions">
                <button class="btn btn-small tool-bisect-mark" data-result="good">Mark good</button>
                <button class="btn btn-small tool-bisect-mark" data-result="bad">Mark bad</button>
                <button class="btn btn-small tool-bisect-mark" data-result="skip">Skip</button>
                <button id="tool-bisect-reset" class="btn btn-small btn-danger">Reset</button>
              </div>` : `
              <p>Find the first bad commit through binary search.</p>
              <input id="tool-bisect-good" placeholder="Known good commit hash">
              <input id="tool-bisect-bad" placeholder="Known bad commit hash">
              <button id="tool-bisect-start" class="btn btn-small">Start bisect</button>`}
          </section>

          <section class="tool-card">
            <h4>Git LFS ${lfs.available ? `<span class="credential-badge success">${escapeHtml(lfs.version)}</span>` : '<span class="credential-badge">unavailable</span>'}</h4>
            <p>Tracked patterns: ${lfsPatterns}. LFS files: ${lfs.files?.length || 0}.</p>
            ${lfs.available ? `
              <input id="tool-lfs-pattern" placeholder="e.g. *.psd">
              <div class="runtime-actions">
                <button id="tool-lfs-init" class="btn btn-small">Initialize locally</button>
                <button id="tool-lfs-track" class="btn btn-small">Track pattern</button>
                <button id="tool-lfs-untrack" class="btn btn-small">Untrack pattern</button>
              </div>` : '<p>Install Git LFS in the selected Git runtime to enable this module.</p>'}
          </section>

          <section class="tool-card">
            <h4>Sparse checkout ${sparse.enabled ? '<span class="credential-badge success">enabled</span>' : ''}</h4>
            <p>Keep only selected directories in large monorepos. One repository-relative directory per line.</p>
            <textarea id="tool-sparse-paths" rows="4" placeholder="src\ndocs">${escapeHtml((sparse.paths || []).join('\n'))}</textarea>
            <div class="runtime-actions">
              <button id="tool-sparse-apply" class="btn btn-small">Apply paths</button>
              ${sparse.enabled ? '<button id="tool-sparse-disable" class="btn btn-small btn-danger">Disable</button>' : ''}
            </div>
          </section>

          <section class="tool-card">
            <h4>Maintenance</h4>
            <p>Strategy: <code>${escapeHtml(maintenance.strategy || 'default')}</code>. Run safe repository optimization now or register scheduled Git maintenance.</p>
            <div class="runtime-actions">
              <button id="tool-maintenance-run" class="btn btn-small">Run now</button>
              <button id="tool-maintenance-start" class="btn btn-small">Enable schedule</button>
              <button id="tool-maintenance-stop" class="btn btn-small">Disable schedule</button>
            </div>
          </section>

          <section class="tool-card">
            <h4>Git hosting</h4>
            <p>${providerRepository
              ? `Detected ${escapeHtml(providerRepository.provider)} repository <code>${escapeHtml(providerRepository.owner)}/${escapeHtml(providerRepository.repo)}</code>.`
              : 'No supported GitHub, GitLab, or Bitbucket remote was detected.'}</p>
            <p>Secure token store: ${providerStatus.encryption.available ? escapeHtml(providerStatus.encryption.backend) : 'unavailable'}.</p>
            <div class="runtime-actions">
              <button id="tool-provider-accounts" class="btn btn-small">Accounts & tokens</button>
              ${providerRepository ? '<button id="tool-provider-prs" class="btn btn-small">Pull requests</button><button id="tool-provider-create" class="btn btn-small">Create PR/MR</button>' : ''}
            </div>
          </section>

          <section class="tool-card">
            <h4>Repository profiles <span class="credential-badge">${profiles.length}</span></h4>
            <p>Apply a reusable identity, Git runtime, SSH key, line-ending policy, and pull strategy to this repository.</p>
            <button id="tool-profiles" class="btn btn-small">Manage profiles</button>
          </section>
        </div>
      `, []);
      $('#modal').classList.add('modal-wide');

      $$('.tool-worktree-open').forEach(button => button.addEventListener('click', () => {
        const item = worktrees[Number(button.dataset.index)];
        if (item) void openRepoPath(item.path);
      }));
      $$('.tool-worktree-remove').forEach(button => button.addEventListener('click', async () => {
        const item = worktrees[Number(button.dataset.index)];
        if (!item || !confirm(`Remove worktree at ${item.path}? The directory must be clean.`)) return;
        try { await window.api.removeWorktree(item.path, false); toast('Worktree removed', 'success'); await showAdvancedToolsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      }));
      $('#tool-worktree-add')?.addEventListener('click', async () => {
        try {
          const targetPath = $('#tool-worktree-path').value.trim();
          const branch = $('#tool-worktree-branch').value.trim();
          const newBranch = $('#tool-worktree-new-branch').value.trim();
          await window.api.addWorktree({ path: targetPath, branch: branch || undefined, newBranch: newBranch || undefined });
          toast('Worktree added', 'success');
          await showAdvancedToolsDialog();
        } catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-worktree-prune')?.addEventListener('click', async () => {
        try { await window.api.pruneWorktrees(); toast('Stale worktree metadata pruned', 'success'); await showAdvancedToolsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-reflog')?.addEventListener('click', showReflogDialog);
      $('#tool-rebase-plan')?.addEventListener('click', async () => {
        try {
          const preview = await window.api.interactiveRebasePreview($('#tool-rebase-upstream').value.trim());
          showInteractiveRebasePlan(preview);
        } catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-patch-export')?.addEventListener('click', async () => {
        try {
          const result = await window.api.exportPatch($('#tool-patch-hash').value.trim());
          if (!result.canceled) toast(`Patch saved: ${result.path}`, 'success');
        } catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-patch-import')?.addEventListener('click', async () => {
        try {
          const result = await window.api.importPatch();
          if (!result.canceled) { toast('Patch imported and committed', 'success'); await refresh(); }
        } catch (error) { toast(error.message, 'error'); await refresh(); }
      });
      $('#tool-bisect-start')?.addEventListener('click', async () => {
        try { await window.api.startBisect($('#tool-bisect-good').value.trim(), $('#tool-bisect-bad').value.trim()); await refresh(); await showAdvancedToolsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      $$('.tool-bisect-mark').forEach(button => button.addEventListener('click', async () => {
        try {
          const result = await window.api.markBisect(button.dataset.result);
          toast(result.output || `Marked ${button.dataset.result}`, 'info');
          await refresh();
          await showAdvancedToolsDialog();
        } catch (error) { toast(error.message, 'error'); }
      }));
      $('#tool-bisect-reset')?.addEventListener('click', async () => {
        try { await window.api.resetBisect(); await refresh(); await showAdvancedToolsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-lfs-init')?.addEventListener('click', async () => {
        try { await window.api.initializeLfs(); toast('Git LFS initialized', 'success'); await showAdvancedToolsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      for (const [selector, enabled] of [['#tool-lfs-track', true], ['#tool-lfs-untrack', false]]) {
        $(selector)?.addEventListener('click', async () => {
          try { await window.api.trackLfs($('#tool-lfs-pattern').value.trim(), enabled); toast(`LFS pattern ${enabled ? 'tracked' : 'untracked'}`, 'success'); await refresh(); await showAdvancedToolsDialog(); }
          catch (error) { toast(error.message, 'error'); }
        });
      }
      $('#tool-sparse-apply')?.addEventListener('click', async () => {
        const paths = $('#tool-sparse-paths').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        try { await window.api.setSparsePaths(paths); toast('Sparse checkout updated', 'success'); await refresh(); await showAdvancedToolsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-sparse-disable')?.addEventListener('click', async () => {
        try { await window.api.disableSparse(); toast('Sparse checkout disabled', 'success'); await refresh(); await showAdvancedToolsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-maintenance-run')?.addEventListener('click', async () => {
        try { showLoading('Running Git maintenance...'); await window.api.runMaintenance(); toast('Maintenance completed', 'success'); }
        catch (error) { toast(error.message, 'error'); } finally { hideLoading(); }
      });
      $('#tool-maintenance-start')?.addEventListener('click', async () => {
        try { await window.api.setMaintenance(true); toast('Scheduled maintenance enabled', 'success'); }
        catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-maintenance-stop')?.addEventListener('click', async () => {
        try { await window.api.setMaintenance(false); toast('Scheduled maintenance disabled', 'info'); }
        catch (error) { toast(error.message, 'error'); }
      });
      $('#tool-provider-accounts')?.addEventListener('click', showProviderAccountsDialog);
      $('#tool-provider-prs')?.addEventListener('click', () => showPullRequestsDialog(providerRepository));
      $('#tool-provider-create')?.addEventListener('click', () => showCreatePullRequestDialog(providerRepository));
      $('#tool-profiles')?.addEventListener('click', showProfilesDialog);
    } catch (error) {
      toast(`Unable to load repository tools: ${error.message}`, 'error');
    } finally {
      hideLoading();
    }
  }

  async function showReflogDialog() {
    try {
      const entries = await window.api.reflog(300);
      const rows = entries.map((entry, index) => `
        <div class="tool-list-row reflog-row">
          <div><strong><code>${escapeHtml(entry.hashShort)}</code> ${escapeHtml(entry.selector)}</strong><span>${escapeHtml(entry.message)}</span><small>${escapeHtml(formatDate(entry.date))}</small></div>
          <button class="btn btn-small reflog-recover" data-index="${index}">Recover</button>
        </div>`).join('');
      showModal('Reflog & Recovery', `<div class="tool-list reflog-list">${rows || '<div class="empty-inline">Reflog is empty</div>'}</div>`, []);
      $('#modal').classList.add('modal-wide');
      $$('.reflog-recover').forEach(button => button.addEventListener('click', () => {
        const entry = entries[Number(button.dataset.index)];
        showModal('Recover commit', `
          <p>Create a new branch at <code>${escapeHtml(entry.hash)}</code>.</p>
          <div class="form-group"><label>Branch name</label><input id="recovery-branch" value="recovery/${escapeHtml(entry.hashShort)}"></div>
        `, [{ label: 'Create branch', primary: true, onClick: async () => {
          await window.api.recoverToBranch(entry.hash, $('#recovery-branch').value.trim());
          await refresh();
          toast('Recovery branch created', 'success');
        } }]);
      }));
    } catch (error) { toast(error.message, 'error'); }
  }

  function showInteractiveRebasePlan(preview) {
    const plan = preview.commits.map(commit => ({ ...commit, action: 'pick', message: commit.subject }));
    const capture = () => {
      $$('.rebase-plan-row').forEach((row, index) => {
        if (!plan[index]) return;
        plan[index].action = row.querySelector('select').value;
        plan[index].message = row.querySelector('input').value;
      });
    };
    const render = () => {
      const rows = plan.map((item, index) => `
        <div class="rebase-plan-row" data-index="${index}">
          <div class="rebase-plan-order">
            <button class="btn btn-small rebase-plan-up" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="btn btn-small rebase-plan-down" ${index === plan.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          </div>
          <select aria-label="Action for ${escapeHtml(item.hashShort)}">
            ${['pick', 'reword', 'squash', 'fixup', 'drop'].map(action => `<option value="${action}" ${item.action === action ? 'selected' : ''}>${action}</option>`).join('')}
          </select>
          <code>${escapeHtml(item.hashShort)}</code>
          <input value="${escapeHtml(item.message)}" maxlength="100000" aria-label="Commit message">
        </div>`).join('');
      showModal(`Interactive rebase onto ${preview.upstream}`, `
        <div class="runtime-card"><strong>History rewrite</strong><br>Every listed commit must remain in the plan; use <em>drop</em> to remove one. If a conflict occurs, resolve it in the operation bar and choose Continue. Abort restores the original HEAD.</div>
        <div class="rebase-plan-list">${rows}</div>
      `, [{ label: 'Start rebase', primary: true, onClick: async () => {
        capture();
        if (!confirm(`Rewrite ${plan.length} commit(s) on ${preview.upstream}? A backup ref will be retained.`)) return false;
        try {
          showLoading('Running interactive rebase...');
          const result = await window.api.startInteractiveRebase(preview.upstream, plan.map(item => ({ hash: item.hash, action: item.action, message: item.message })));
          await refresh();
          toast(`Interactive rebase complete. Backup: ${result.backupRef}`, 'success');
        } catch (error) {
          await refresh();
          throw error;
        } finally { hideLoading(); }
      } }]);
      $('#modal').classList.add('modal-wide');
      $$('.rebase-plan-row').forEach((row, index) => {
        row.querySelector('select').addEventListener('change', event => {
          row.querySelector('input').disabled = event.target.value !== 'reword' && event.target.value !== 'squash';
        });
        row.querySelector('input').disabled = !['reword', 'squash'].includes(plan[index].action);
        row.querySelector('.rebase-plan-up')?.addEventListener('click', () => {
          capture();
          [plan[index - 1], plan[index]] = [plan[index], plan[index - 1]];
          render();
        });
        row.querySelector('.rebase-plan-down')?.addEventListener('click', () => {
          capture();
          [plan[index], plan[index + 1]] = [plan[index + 1], plan[index]];
          render();
        });
      });
    };
    render();
  }

  async function showProviderAccountsDialog() {
    try {
      const status = await window.api.providerStatus();
      const rows = status.providers.map(provider => `
        <div class="tool-list-row">
          <div><strong>${escapeHtml(provider.name)} ${provider.configured ? '<span class="credential-badge success">configured</span>' : ''}</strong><code>${escapeHtml(provider.baseUrl)}</code>${provider.username ? `<small>${escapeHtml(provider.username)}</small>` : ''}</div>
          ${provider.configured ? `<button class="btn btn-small btn-danger provider-remove" data-provider="${provider.id}">Remove</button>` : ''}
        </div>`).join('');
      showModal('Hosting Accounts & Token Vault', `
        <div class="runtime-card ${status.encryption.available ? 'runtime-ok' : 'runtime-error'}">
          ${status.encryption.available
            ? `Tokens are encrypted with the operating-system backend: <strong>${escapeHtml(status.encryption.backend)}</strong>.`
            : 'Secure OS encryption is unavailable. KitsuneGIT will not persist access tokens on this system.'}
        </div>
        <div class="tool-list">${rows}</div>
        <section class="settings-section">
          <h4>Add or replace an account</h4>
          <div class="form-grid">
            <div class="form-group"><label>Provider</label><select id="provider-kind">${status.providers.map(provider => `<option value="${provider.id}" data-url="${escapeHtml(provider.baseUrl)}">${escapeHtml(provider.name)}</option>`).join('')}</select></div>
            <div class="form-group"><label>API base URL</label><input id="provider-base-url" value="${escapeHtml(status.providers[0]?.baseUrl || '')}"></div>
          </div>
          <div class="form-group"><label>Personal access token</label><input id="provider-token" type="password" autocomplete="off" placeholder="Token is validated before encrypted storage"></div>
          <button id="provider-save" class="btn btn-primary btn-small" ${status.encryption.available ? '' : 'disabled'}>Validate & save</button>
        </section>
      `, []);
      $('#modal').classList.add('modal-wide');
      $('#provider-kind')?.addEventListener('change', event => {
        const option = event.target.selectedOptions[0];
        $('#provider-base-url').value = option?.dataset.url || '';
      });
      $('#provider-save')?.addEventListener('click', async () => {
        try {
          showLoading('Validating provider token...');
          await window.api.saveProviderAccount({
            provider: $('#provider-kind').value,
            baseUrl: $('#provider-base-url').value.trim(),
            token: $('#provider-token').value
          });
          toast('Provider account saved securely', 'success');
          await showProviderAccountsDialog();
        } catch (error) { toast(error.message, 'error'); } finally { hideLoading(); }
      });
      $$('.provider-remove').forEach(button => button.addEventListener('click', async () => {
        if (!confirm(`Remove the saved ${button.dataset.provider} token?`)) return;
        try { await window.api.removeProviderAccount(button.dataset.provider); await showProviderAccountsDialog(); }
        catch (error) { toast(error.message, 'error'); }
      }));
    } catch (error) { toast(error.message, 'error'); }
  }

  async function showPullRequestsDialog(repository) {
    try {
      showLoading('Loading pull requests...');
      const items = await window.api.pullRequests(repository);
      const rows = items.map((item, index) => `
        <div class="tool-list-row">
          <div><strong>#${escapeHtml(item.id)} ${escapeHtml(item.title)}</strong><span>${escapeHtml(item.source)} → ${escapeHtml(item.target)} · ${escapeHtml(item.author)}</span></div>
          ${item.url ? `<button class="btn btn-small provider-pr-open" data-index="${index}">Open</button>` : ''}
        </div>`).join('');
      showModal(`Open requests — ${repository.owner}/${repository.repo}`, `<div class="tool-list reflog-list">${rows || '<div class="empty-inline">No open pull requests</div>'}</div>`, []);
      $('#modal').classList.add('modal-wide');
      $$('.provider-pr-open').forEach(button => button.addEventListener('click', () => {
        const url = items[Number(button.dataset.index)]?.url;
        if (url) void window.api.openExternalUrl(url);
      }));
    } catch (error) { toast(error.message, 'error'); } finally { hideLoading(); }
  }

  function showCreatePullRequestDialog(repository) {
    const source = state.status?.current || '';
    const branches = state.branches?.local || [];
    const target = branches.find(branch => branch === 'main') || branches.find(branch => branch === 'master') || branches.find(branch => branch !== source) || '';
    showModal(`Create request — ${repository.owner}/${repository.repo}`, `
      <div class="form-group"><label>Title</label><input id="provider-pr-title" maxlength="500"></div>
      <div class="form-grid">
        <div class="form-group"><label>Source branch</label><input id="provider-pr-source" value="${escapeHtml(source)}"></div>
        <div class="form-group"><label>Target branch</label><input id="provider-pr-target" value="${escapeHtml(target)}"></div>
      </div>
      <div class="form-group"><label>Description</label><textarea id="provider-pr-description" rows="8"></textarea></div>
    `, [{ label: 'Create', primary: true, onClick: async () => {
      const result = await window.api.createPullRequest(repository, {
        title: $('#provider-pr-title').value.trim(),
        source: $('#provider-pr-source').value.trim(),
        target: $('#provider-pr-target').value.trim(),
        description: $('#provider-pr-description').value
      });
      toast(`Request #${result.id} created`, 'success');
      if (result.url) await window.api.openExternalUrl(result.url);
    } }]);
  }

  async function showProfilesDialog() {
    try {
      const profiles = await window.api.profiles();
      const rows = profiles.map((profile, index) => `
        <div class="tool-list-row">
          <div><strong>${escapeHtml(profile.name)}</strong><span>${escapeHtml(profile.identityName || 'No identity')} ${profile.identityEmail ? `&lt;${escapeHtml(profile.identityEmail)}&gt;` : ''}</span><small>${escapeHtml(profile.runtimeMode)} Git${profile.sshKeyPath ? ` · SSH ${escapeHtml(profile.sshKeyPath)}` : ''}</small></div>
          <div class="credential-actions"><button class="btn btn-small profile-apply" data-index="${index}">Apply</button><button class="btn btn-small btn-danger profile-remove" data-index="${index}">Delete</button></div>
        </div>`).join('');
      showModal('Repository Profiles', `
        <div class="tool-list">${rows || '<div class="empty-inline">No saved profiles</div>'}</div>
        <section class="settings-section">
          <h4>Create or replace a profile</h4>
          <div class="form-grid three">
            <div class="form-group"><label>Profile name</label><input id="profile-name" placeholder="Work"></div>
            <div class="form-group"><label>Git user name</label><input id="profile-user-name"></div>
            <div class="form-group"><label>Git email</label><input id="profile-email" type="email"></div>
          </div>
          <div class="form-grid three">
            <div class="form-group"><label>Runtime</label><select id="profile-runtime"><option value="auto">Automatic</option><option value="system">System</option><option value="managed">Managed</option><option value="custom">Custom</option></select></div>
            <div class="form-group"><label>core.autocrlf</label><select id="profile-autocrlf"><option value="">Leave unchanged</option><option value="true">true</option><option value="false">false</option><option value="input">input</option></select></div>
            <div class="form-group"><label>pull.rebase</label><select id="profile-pull-rebase"><option value="">Leave unchanged</option><option value="false">false</option><option value="true">true</option><option value="merges">merges</option><option value="interactive">interactive</option></select></div>
          </div>
          <div class="form-group"><label>Custom Git executable</label><div class="input-row"><input id="profile-runtime-path"><button id="profile-runtime-browse" class="btn btn-small">Browse</button></div></div>
          <div class="form-group"><label>SSH private key (optional)</label><div class="input-row"><input id="profile-ssh-key"><button id="profile-ssh-browse" class="btn btn-small">Browse</button></div></div>
          <button id="profile-save" class="btn btn-primary btn-small">Save profile</button>
        </section>
      `, []);
      $('#modal').classList.add('modal-wide');
      $('#profile-runtime-browse')?.addEventListener('click', async () => {
        const selected = await window.api.openGitExecutable();
        if (selected) { $('#profile-runtime-path').value = selected; $('#profile-runtime').value = 'custom'; }
      });
      $('#profile-ssh-browse')?.addEventListener('click', async () => {
        const selected = await window.api.openSshKey();
        if (selected) $('#profile-ssh-key').value = selected;
      });
      $('#profile-save')?.addEventListener('click', async () => {
        try {
          await window.api.saveProfile({
            name: $('#profile-name').value.trim(),
            identityName: $('#profile-user-name').value.trim(),
            identityEmail: $('#profile-email').value.trim(),
            runtimeMode: $('#profile-runtime').value,
            runtimePath: $('#profile-runtime-path').value.trim(),
            sshKeyPath: $('#profile-ssh-key').value.trim(),
            autocrlf: $('#profile-autocrlf').value,
            pullRebase: $('#profile-pull-rebase').value
          });
          toast('Profile saved', 'success');
          await showProfilesDialog();
        } catch (error) { toast(error.message, 'error'); }
      });
      $$('.profile-apply').forEach(button => button.addEventListener('click', async () => {
        const profile = profiles[Number(button.dataset.index)];
        try { await window.api.applyProfile(profile.name); await refreshRuntimeIndicators(); await refresh(); toast(`Profile ${profile.name} applied`, 'success'); }
        catch (error) { toast(error.message, 'error'); }
      }));
      $$('.profile-remove').forEach(button => button.addEventListener('click', async () => {
        const profile = profiles[Number(button.dataset.index)];
        if (!confirm(`Delete profile ${profile.name}?`)) return;
        try { await window.api.removeProfile(profile.name); await showProfilesDialog(); }
        catch (error) { toast(error.message, 'error'); }
      }));
    } catch (error) { toast(error.message, 'error'); }
  }

  function pathEquals(left, right) {
    const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    return normalize(left) === normalize(right);
  }

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
    }]);
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
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      showCommandPalette();
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
      const activePath = session.tabs[session.activeIdx]?.path;
      for (const tab of session.tabs) {
        await openRepoPath(tab.path, { notify: false });
      }
      const restoredIndex = state.tabs.findIndex(tab => tab.path === activePath);
      if (restoredIndex >= 0) {
        await switchTab(restoredIndex, true);
      }
    }
  })();

})();
