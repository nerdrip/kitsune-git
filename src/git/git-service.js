const fs = require('node:fs');
const path = require('node:path');
const simpleGit = require('simple-git');
const { runProcess } = require('../main/process-runner');
const { buildSelectedPatch } = require('./patch');
const {
  assertMessage,
  assertRefName,
  assertRemoteName,
  assertRemoteUrl,
  assertRevision,
  assertSingleLine,
  assertStashIndex,
  literalPathspec,
  literalPathspecs,
  normalizeMaxCount,
  normalizeRelativePath,
  normalizeRepositoryPath,
  sanitizeGitEnvironment
} = require('./validation');

const EXPOSED_CONFIG_KEYS = new Set([
  'user.name',
  'user.email',
  'core.autocrlf',
  'pull.rebase',
  'push.default'
]);
const LOG_FORMAT = '--format=%H%x00%h%x00%aI%x00%s%x00%aN%x00%aE%x00%D%x00%P%x1e';

class GitService {
  constructor(repoPath, runtime = {}) {
    this.repoPath = normalizeRepositoryPath(repoPath);
    const hasTrustedRuntime = Boolean(runtime.environment && typeof runtime.environment === 'object');
    this.runtime = {
      binary: typeof runtime.binary === 'string' && runtime.binary ? runtime.binary : 'git',
      environment: sanitizeGitEnvironment(hasTrustedRuntime ? runtime.environment : process.env, { trustedRuntime: hasTrustedRuntime })
    };
    this.operationSignal = null;
    this.git = this._createGit(this.repoPath);
  }

  _createGit(baseDir) {
    const git = simpleGit({
      baseDir,
      binary: this.runtime.binary,
      maxConcurrentProcesses: 6,
      trimmed: false,
      unsafe: { allowUnsafeCustomBinary: true }
    });
    const environment = { ...this.runtime.environment };
    // The GUI never delegates editing to an ambient shell command. Removing
    // inherited editors also keeps simple-git's unsafe-editor guard enabled.
    delete environment.EDITOR;
    delete environment.GIT_EDITOR;
    delete environment.GIT_SEQUENCE_EDITOR;
    git.env(environment);
    return git;
  }

  async _runGit(args, options = {}) {
    return await runProcess(this.runtime.binary, args, {
      cwd: options.cwd || this.repoPath,
      env: this.runtime.environment,
      input: options.input,
      signal: options.signal || this.operationSignal,
      timeoutMs: options.timeoutMs || 60_000,
      maxOutput: options.maxOutput || 8 * 1024 * 1024,
      rejectOnError: options.rejectOnError
    });
  }

  // ─── Repository ──────────────────────────────────────────

  async init() {
    await this.git.init();
    return await this.getStatus();
  }

  async clone(url, targetPath) {
    const safeUrl = assertRemoteUrl(url);
    const safeTarget = normalizeRepositoryPath(targetPath);
    const parentDirectory = path.dirname(safeTarget);
    const cloneGit = this._createGit(fs.existsSync(parentDirectory) ? parentDirectory : process.cwd());
    await cloneGit.clone(safeUrl, safeTarget);
    this.repoPath = safeTarget;
    this.git = this._createGit(safeTarget);
    return await this.getStatus();
  }

  async assertRepository() {
    if (!await this.git.checkIsRepo()) {
      throw new Error(`Selected directory is not a Git repository: ${this.repoPath}`);
    }
    return true;
  }

  // ─── Status ──────────────────────────────────────────────

  async getStatus() {
    const [status, branchSummary] = await Promise.all([
      this.git.status(),
      this.git.branchLocal()
    ]);
    return {
      current: status.current,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.files
        .filter(f => f.index && f.index !== ' ' && f.index !== '?')
        .map(f => {
          const statusMap = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };
          return { path: f.path, status: statusMap[f.index] || 'staged' };
        }),
      modified: status.modified.map(f => ({ path: f, status: 'modified' })),
      not_added: status.not_added.map(f => ({ path: f, status: 'untracked' })),
      deleted: status.deleted.map(f => ({ path: f, status: 'deleted' })),
      conflicted: status.conflicted.map(f => ({ path: f, status: 'conflicted' })),
      renamed: status.renamed.map(f => ({ path: f.to, from: f.from, status: 'renamed' })),
      created: status.created.map(f => ({ path: f, status: 'created' })),
      branches: branchSummary.all,
      isClean: status.isClean(),
      repoPath: this.repoPath
    };
  }

  // ─── Log ─────────────────────────────────────────────────

  async getLog(maxCount = 200) {
    try {
      const safeMaxCount = normalizeMaxCount(maxCount);
      const raw = await this.git.raw([
        'log', '--all', '--decorate', `--max-count=${safeMaxCount}`,
        LOG_FORMAT
      ]);
      return this._parseLog(raw);
    } catch {
      return [];
    }
  }

  // ─── Diff ────────────────────────────────────────────────

  async getDiff(filePath) {
    const args = ['diff'];
    if (filePath) args.push('--', literalPathspec(this.repoPath, filePath));
    return (await this._runGit(args, { maxOutput: 16 * 1024 * 1024 })).stdout;
  }

  async getDiffCached(filePath) {
    const args = ['diff', '--cached'];
    if (filePath) args.push('--', literalPathspec(this.repoPath, filePath));
    return (await this._runGit(args, { maxOutput: 16 * 1024 * 1024 })).stdout;
  }

  async applySelection(filePath, selection, action) {
    const safePath = normalizeRelativePath(this.repoPath, filePath);
    if (!['stage', 'unstage', 'discard'].includes(action)) throw new Error('Unsupported patch action');
    const diff = action === 'unstage' ? await this.getDiffCached(safePath) : await this.getDiff(safePath);
    const patch = buildSelectedPatch(diff, selection);
    const args = ['apply', '--recount', '--unidiff-zero', '--whitespace=nowarn'];
    if (action === 'stage' || action === 'unstage') args.push('--cached');
    if (action === 'unstage' || action === 'discard') args.push('--reverse');
    args.push('-');
    await this._runGit(args, { input: patch });
    return await this.getStatus();
  }

  // ─── Staging ─────────────────────────────────────────────

  async stage(files) {
    await this.git.add(literalPathspecs(this.repoPath, files));
    return await this.getStatus();
  }

  async unstage(files) {
    await this.git.reset(['HEAD', '--', ...literalPathspecs(this.repoPath, files)]);
    return await this.getStatus();
  }

  async stageAll() {
    await this.git.add('-A');
    return await this.getStatus();
  }

  async unstageAll() {
    await this.git.reset(['HEAD']);
    return await this.getStatus();
  }

  // ─── Commit ──────────────────────────────────────────────

  async commit(message, amend = false) {
    const safeMessage = assertMessage(message, 'Commit message');
    const options = amend ? { '--amend': null } : {};
    await this.git.commit(safeMessage, undefined, options);
    return await this.getStatus();
  }

  // ─── Push / Pull / Fetch ─────────────────────────────────

  async push(remote = 'origin', branch, force = false) {
    const safeRemote = assertRemoteName(remote || 'origin');
    const safeBranch = branch ? assertRefName(branch, 'Branch name') : undefined;
    const options = force ? ['--force-with-lease'] : [];
    if (safeBranch) {
      await this.git.push(safeRemote, safeBranch, options);
    } else {
      await this.git.push(safeRemote, undefined, options);
    }
    return await this.getStatus();
  }

  async pull(remote = 'origin', branch, rebase = false) {
    const safeRemote = assertRemoteName(remote || 'origin');
    const safeBranch = branch ? assertRefName(branch, 'Branch name') : undefined;
    const options = {};
    if (rebase) options['--rebase'] = null;
    if (safeBranch) {
      await this.git.pull(safeRemote, safeBranch, options);
    } else {
      await this.git.pull(safeRemote, undefined, options);
    }
    return await this.getStatus();
  }

  async fetch(remote, prune = false) {
    const options = prune ? ['--prune'] : [];
    if (remote) {
      await this.git.fetch(assertRemoteName(remote), undefined, options);
    } else {
      await this.git.fetch(['--all', ...options]);
    }
    return await this.getStatus();
  }

  // ─── Branches ────────────────────────────────────────────

  async getBranches() {
    const local = await this.git.branchLocal();
    let remote = { all: [] };
    try {
      remote = await this.git.branch(['-r']);
    } catch { /* no remotes */ }
    return {
      current: local.current,
      local: local.all,
      remote: remote.all,
      details: local.branches
    };
  }

  async createBranch(name, startPoint) {
    const safeName = assertRefName(name, 'Branch name');
    if (startPoint) {
      await this.git.checkoutBranch(safeName, assertRefName(startPoint, 'Start point'));
    } else {
      await this.git.checkoutLocalBranch(safeName);
    }
    return await this.getBranches();
  }

  async deleteBranch(name, force = false) {
    const safeName = assertRefName(name, 'Branch name');
    if (force) {
      await this.git.branch(['-D', safeName]);
    } else {
      await this.git.branch(['-d', safeName]);
    }
    return await this.getBranches();
  }

  async checkout(branch) {
    await this.git.checkout(assertRefName(branch, 'Branch name'));
    return await this.getStatus();
  }

  // ─── Merge / Rebase ──────────────────────────────────────

  async merge(branch, noFf = false) {
    const safeBranch = assertRefName(branch, 'Branch name');
    const options = noFf ? ['--no-ff'] : [];
    await this.git.merge([...options, safeBranch]);
    return await this.getStatus();
  }

  async rebase(branch) {
    await this.git.rebase([assertRefName(branch, 'Branch name')]);
    return await this.getStatus();
  }

  async rebaseAbort() {
    await this.git.rebase(['--abort']);
    return await this.getStatus();
  }

  async rebaseContinue() {
    await this._runGit(['-c', 'core.editor=true', 'rebase', '--continue']);
    return await this.getStatus();
  }

  // ─── Tags ───────────────────────────────────────────────

  async getTags() {
    const tags = await this.git.tags();
    return tags.all;
  }

  async createTag(name, message, commitHash) {
    const safeName = assertRefName(name, 'Tag name');
    const safeHash = commitHash ? assertRevision(commitHash) : undefined;
    if (message) {
      const args = ['-a', safeName, '-m', assertMessage(message, 'Tag message')];
      if (safeHash) args.push(safeHash);
      await this.git.tag(args);
    } else {
      const args = [safeName];
      if (safeHash) args.push(safeHash);
      await this.git.tag(args);
    }
    return await this.getTags();
  }

  async deleteTag(name) {
    await this.git.tag(['-d', assertRefName(name, 'Tag name')]);
    return await this.getTags();
  }

  async pushTag(name, remote = 'origin') {
    await this.git.push(assertRemoteName(remote || 'origin'), assertRefName(name, 'Tag name'));
    return await this.getTags();
  }

  // ─── Stash ──────────────────────────────────────────────

  async stash(message, includeUntracked = false) {
    const args = ['push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message) { args.push('-m', assertMessage(message, 'Stash message')); }
    await this.git.stash(args);
    return await this.getStatus();
  }

  async stashList() {
    const result = await this.git.stashList();
    return result.all.map((entry, index) => ({
      index,
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name
    }));
  }

  async stashPop(index = 0) {
    await this.git.stash(['pop', `stash@{${assertStashIndex(index)}}`]);
    return await this.getStatus();
  }

  async stashApply(index = 0) {
    await this.git.stash(['apply', `stash@{${assertStashIndex(index)}}`]);
    return await this.getStatus();
  }

  async stashDrop(index = 0) {
    await this.git.stash(['drop', `stash@{${assertStashIndex(index)}}`]);
    return await this.stashList();
  }

  // ─── Remotes ────────────────────────────────────────────

  async getRemotes() {
    return await this.git.getRemotes(true);
  }

  async addRemote(name, url) {
    await this.git.addRemote(assertRemoteName(name), assertRemoteUrl(url));
    return await this.getRemotes();
  }

  async removeRemote(name) {
    await this.git.removeRemote(assertRemoteName(name));
    return await this.getRemotes();
  }

  // ─── Advanced Operations ────────────────────────────────

  async cherryPick(hash) {
    await this.git.raw(['cherry-pick', assertRevision(hash)]);
    return await this.getStatus();
  }

  async revert(hash) {
    await this.git.revert(assertRevision(hash));
    return await this.getStatus();
  }

  async reset(hash, mode = '--mixed') {
    const validModes = ['--soft', '--mixed', '--hard'];
    if (!validModes.includes(mode)) {
      throw new Error('Invalid reset mode');
    }
    await this.git.reset([mode, assertRevision(hash)]);
    return await this.getStatus();
  }

  async blame(filePath) {
    const result = await this.git.raw(['blame', '--porcelain', '--', literalPathspec(this.repoPath, filePath)]);
    return this._parseBlame(result);
  }

  async showCommit(hash) {
    const safeHash = assertRevision(hash);
    const result = await this.git.show([safeHash, '--stat', '--format=fuller']);
    const diffResult = await this.git.show([safeHash, '--format=']);
    // Parse commit metadata
    const meta = {};
    const lines = result.split('\n');
    for (const line of lines) {
      if (line.startsWith('commit ')) meta.hash = line.substring(7).trim();
      else if (line.startsWith('Author:')) meta.author = line.substring(7).trim();
      else if (line.startsWith('AuthorDate:')) meta.authorDate = line.substring(11).trim();
      else if (line.startsWith('Commit:')) meta.committer = line.substring(7).trim();
      else if (line.startsWith('CommitDate:')) meta.commitDate = line.substring(11).trim();
      else if (line.startsWith('    ') && !meta.message) meta.message = line.trim();
    }
    return { info: result, diff: diffResult, meta };
  }

  async discardChanges(filePath) {
    await this.git.checkout(['--', literalPathspec(this.repoPath, filePath)]);
    return await this.getStatus();
  }

  async discardUntracked(filePath) {
    await this.git.clean('f', [literalPathspec(this.repoPath, filePath)]);
    return await this.getStatus();
  }

  async addToGitignore(pattern) {
    const safePattern = assertSingleLine(pattern, 'Ignore pattern');
    const gitignorePath = path.join(this.repoPath, '.gitignore');
    let content = '';
    try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* no .gitignore yet */ }
    const existingPatterns = content.split(/\r?\n/);
    if (existingPatterns.includes(safePattern)) return await this.getStatus();
    if (content && !content.endsWith('\n')) content += '\n';
    content += safePattern + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf8');
    return await this.getStatus();
  }

  async discardAllChanges() {
    await this.git.checkout(['--', '.']);
    await this.git.clean('f', ['-d']);
    return await this.getStatus();
  }

  async getFileHistory(filePath) {
    const safePath = literalPathspec(this.repoPath, filePath);
    const log = await this.git.log({ file: safePath, maxCount: 100 });
    return log.all.map(entry => ({
      hash: entry.hash,
      hashShort: entry.hash.substring(0, 7),
      date: entry.date,
      message: entry.message,
      author: entry.author_name
    }));
  }

  // ─── Diff Stats ─────────────────────────────────────────

  async getDiffStats() {
    try {
      const result = await this.git.diff(['--numstat']);
      return this._parseNumstat(result);
    } catch {
      return [];
    }
  }

  async getDiffStatsCached() {
    try {
      const result = await this.git.diff(['--cached', '--numstat']);
      return this._parseNumstat(result);
    } catch {
      return [];
    }
  }

  // ─── Submodules ────────────────────────────────────────

  async getSubmodules() {
    try {
      const result = await this.git.raw(['submodule', 'status']);
      if (!result || !result.trim()) return [];
      return result.trim().split('\n').map(line => {
        const match = line.replace(/\r$/, '').match(/^([ +\-U])?([0-9a-f]+)\s+(.+?)(?:\s+\((.+)\))?$/);
        if (!match) return null;
        return { status: match[1] || ' ', hash: match[2], path: match[3], describe: match[4] || '' };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  async updateSubmodule(submodulePath) {
    const args = ['submodule', 'update', '--init', '--recursive'];
    if (submodulePath) args.push('--', normalizeRelativePath(this.repoPath, submodulePath, 'Submodule path'));
    await this.git.raw(args);
    return await this.getSubmodules();
  }

  // ─── Git Config ────────────────────────────────────────

  async getConfig() {
    const result = await this.git.raw(['config', '--list', '--local']);
    const config = {};
    result.trim().split('\n').forEach(line => {
      const idx = line.indexOf('=');
      const key = idx > 0 ? line.substring(0, idx).trim() : '';
      if (EXPOSED_CONFIG_KEYS.has(key)) {
        config[key] = line.substring(idx + 1).replace(/\r$/, '');
      }
    });
    return config;
  }

  async setConfig(key, value) {
    if (!EXPOSED_CONFIG_KEYS.has(key)) throw new Error('Config key not allowed');
    const safeValue = assertSingleLine(value, 'Config value');
    const allowedValues = {
      'core.autocrlf': new Set(['true', 'false', 'input']),
      'pull.rebase': new Set(['true', 'false', 'merges', 'interactive']),
      'push.default': new Set(['nothing', 'current', 'upstream', 'simple', 'matching'])
    };
    if (allowedValues[key] && !allowedValues[key].has(safeValue)) {
      throw new Error(`Invalid value for ${key}`);
    }
    if (key === 'user.email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeValue)) {
      throw new Error('User email is invalid');
    }
    await this.git.raw(['config', '--local', key, safeValue]);
    return await this.getConfig();
  }

  // ─── Last Commit Message ─────────────────────────────

  async getLastCommitMessage() {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest ? log.latest.message : '';
    } catch {
      return '';
    }
  }

  // ─── Commit Diff (single file from a commit) ──────────

  async getCommitFileDiff(hash, filePath) {
    try {
      return await this.git.show([
        assertRevision(hash),
        '--',
        literalPathspec(this.repoPath, filePath)
      ]);
    } catch {
      return '';
    }
  }

  // ─── Branch Rename ─────────────────────────────────────

  async renameBranch(oldName, newName) {
    await this.git.branch([
      '-m',
      assertRefName(oldName, 'Current branch name'),
      assertRefName(newName, 'New branch name')
    ]);
    return await this.getBranches();
  }

  // ─── Search Log ────────────────────────────────────────

  async searchLog(query, maxCount = 200) {
    try {
      const safeQuery = assertSingleLine(query, 'Search query', { maxLength: 500 });
      const safeMaxCount = normalizeMaxCount(maxCount);
      const raw = await this.git.raw([
        'log', '--all', '--decorate', '--fixed-strings', `--max-count=${safeMaxCount}`,
        LOG_FORMAT,
        `--grep=${safeQuery}`
      ]);
      return this._parseLog(raw);
    } catch {
      return [];
    }
  }

  // ─── Commit Files List ────────────────────────────────

  async getCommitFiles(hash) {
    try {
      const result = await this.git.raw([
        'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', assertRevision(hash)
      ]);
      return result.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.replace(/\r$/, '').split('\t');
        const renamed = parts.length > 2;
        return {
          status: parts[0],
          path: renamed ? parts[2] : parts[1],
          oldPath: renamed ? parts[1] : null
        };
      });
    } catch {
      return [];
    }
  }

  // ─── Branch Comparison ────────────────────────────────────

  async getBranchDiff(from, to) {
    const safeFrom = assertRefName(from, 'Base branch');
    const safeTo = assertRefName(to, 'Compared branch');
    return await this.git.diff([`${safeFrom}..${safeTo}`]);
  }

  async getOperationState() {
    const nativeType = await this._nativeOperationType();
    const rebasePlan = this._readRebasePlan();
    const type = rebasePlan ? 'interactive-rebase' : nativeType;
    const status = await this.getStatus();
    return {
      type,
      nativeType,
      inProgress: Boolean(type),
      conflicted: status.conflicted || [],
      progress: rebasePlan ? { current: rebasePlan.index + 1, total: rebasePlan.plan.length, backupRef: rebasePlan.backupRef } : null
    };
  }

  async _nativeOperationType() {
    const gitDirResult = await this._runGit(['rev-parse', '--git-dir']);
    const value = gitDirResult.stdout.trim();
    const gitDirectory = path.isAbsolute(value) ? value : path.resolve(this.repoPath, value);
    let type = null;
    if (fs.existsSync(path.join(gitDirectory, 'rebase-apply', 'applying'))) type = 'am';
    else if (fs.existsSync(path.join(gitDirectory, 'rebase-merge')) || fs.existsSync(path.join(gitDirectory, 'rebase-apply'))) type = 'rebase';
    else if (fs.existsSync(path.join(gitDirectory, 'MERGE_HEAD'))) type = 'merge';
    else if (fs.existsSync(path.join(gitDirectory, 'CHERRY_PICK_HEAD'))) type = 'cherry-pick';
    else if (fs.existsSync(path.join(gitDirectory, 'REVERT_HEAD'))) type = 'revert';
    else if (fs.existsSync(path.join(gitDirectory, 'BISECT_LOG'))) type = 'bisect';
    return type;
  }

  async getConflictFile(filePath) {
    const safePath = normalizeRelativePath(this.repoPath, filePath);
    const listed = await this.git.raw(['ls-files', '-u', '-z', '--', literalPathspec(this.repoPath, safePath)]);
    const stages = {};
    for (const record of listed.split('\0').filter(Boolean)) {
      const match = /^(\d+) ([0-9a-f]{40,64}) ([123])\t([\s\S]+)$/.exec(record);
      if (!match) continue;
      stages[Number(match[3])] = { mode: match[1], hash: match[2], path: match[4] };
    }
    const readStage = async stage => {
      if (!stages[stage]) return null;
      const result = await this._runGit(['cat-file', 'blob', stages[stage].hash], { maxOutput: 16 * 1024 * 1024 });
      return result.stdout;
    };
    const [base, ours, theirs] = await Promise.all([readStage(1), readStage(2), readStage(3)]);
    const target = path.resolve(this.repoPath, ...safePath.split('/'));
    let current = '';
    try { current = fs.readFileSync(target, 'utf8'); } catch { /* deleted side of a conflict */ }
    const binary = [base, ours, theirs, current].some(content => typeof content === 'string' && content.includes('\0'));
    return { path: safePath, base, ours, theirs, current, binary, stages };
  }

  _resolveSafeWorkingTreeFile(filePath) {
    const safePath = normalizeRelativePath(this.repoPath, filePath);
    const target = path.resolve(this.repoPath, ...safePath.split('/'));
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Refusing to resolve a conflict through a symbolic link');
    const repositoryReal = fs.realpathSync(this.repoPath);
    const parentReal = fs.realpathSync(path.dirname(target));
    const relativeParent = path.relative(repositoryReal, parentReal);
    if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
      throw new Error('Conflict file resolves outside the repository');
    }
    return { safePath, target };
  }

  async saveConflictResolution(filePath, content) {
    if (typeof content !== 'string' || content.length > 16 * 1024 * 1024 || content.includes('\0')) {
      throw new Error('Resolved file content is invalid or too large');
    }
    const { safePath, target } = this._resolveSafeWorkingTreeFile(filePath);
    fs.writeFileSync(target, content, 'utf8');
    await this.git.add([literalPathspec(this.repoPath, safePath)]);
    return await this.getStatus();
  }

  async previewInteractiveRebase(upstream) {
    const safeUpstream = assertRefName(upstream, 'Rebase upstream');
    const result = await this._runGit([
      'log', '--reverse', '--format=%H%x00%h%x00%s%x00%aN%x00%aI%x1e', `${safeUpstream}..HEAD`
    ], { maxOutput: 8 * 1024 * 1024 });
    const commits = result.stdout.split('\x1e').map(record => record.replace(/^\r?\n|\r?\n$/g, '')).filter(Boolean).map(record => {
      const [hash, hashShort, subject, author, date] = record.split('\0');
      return { hash, hashShort, subject, author, date };
    });
    if (!commits.length) throw new Error('There are no commits to rebase onto the selected upstream');
    if (commits.length > 500) throw new Error('Interactive rebase is limited to 500 commits');
    return { upstream: safeUpstream, commits };
  }

  async startInteractiveRebase(upstream, plan) {
    const preview = await this.previewInteractiveRebase(upstream);
    const status = await this.getStatus();
    if (!status.isClean) throw new Error('Commit, stash, or discard working-tree changes before interactive rebase');
    if (!Array.isArray(plan) || plan.length !== preview.commits.length) throw new Error('Rebase plan must contain every previewed commit exactly once');
    const expected = new Set(preview.commits.map(commit => commit.hash));
    const actions = new Set(['pick', 'reword', 'squash', 'fixup', 'drop']);
    const normalized = plan.map((item, index) => {
      const hash = assertRevision(item?.hash);
      if (!expected.delete(hash)) throw new Error('Rebase plan contains a duplicate or unexpected commit');
      if (!actions.has(item?.action)) throw new Error('Rebase plan contains an unsupported action');
      if (index === 0 && ['squash', 'fixup'].includes(item.action)) throw new Error('The first retained commit cannot be squash or fixup');
      const message = item.action === 'reword'
        ? assertMessage(item.message, 'Reworded commit message')
        : (typeof item.message === 'string' ? item.message.slice(0, 100_000) : '');
      return { hash, action: item.action, message };
    });
    if (expected.size) throw new Error('Rebase plan omits one or more commits');
    const retained = normalized.filter(item => item.action !== 'drop');
    if (retained.length && ['squash', 'fixup'].includes(retained[0].action)) throw new Error('The first retained commit cannot be squash or fixup');

    const branch = (await this._runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
    const originalHead = (await this._runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const backupRef = `refs/kitsune/backups/rebase-${Date.now()}`;
    await this._runGit(['update-ref', backupRef, originalHead]);
    const state = {
      version: 1,
      upstream: preview.upstream,
      originalBranch: branch,
      originalHead,
      backupRef,
      plan: normalized,
      index: 0,
      phase: null,
      previousMessage: ''
    };
    this._writeRebasePlan(state);
    try {
      await this._runGit(['reset', '--hard', preview.upstream]);
      return await this._runRebasePlan(state);
    } catch (error) {
      error.message = `Interactive rebase paused: ${error.message}`;
      throw error;
    }
  }

  async _runRebasePlan(state) {
    while (state.index < state.plan.length) {
      const item = state.plan[state.index];
      if (item.action === 'drop') {
        state.index += 1;
        this._writeRebasePlan(state);
        continue;
      }
      state.previousMessage = ['squash', 'fixup'].includes(item.action)
        ? (await this._runGit(['log', '-1', '--format=%B'])).stdout.trim()
        : '';
      state.phase = 'cherry-picking';
      this._writeRebasePlan(state);
      await this._runGit(['cherry-pick', item.hash]);
      await this._finalizeRebasePlanItem(state, item);
      state.index += 1;
      state.phase = null;
      state.previousMessage = '';
      this._writeRebasePlan(state);
    }
    this._removeRebasePlan();
    return { status: await this.getStatus(), backupRef: state.backupRef };
  }

  async _finalizeRebasePlanItem(state, item) {
    if (item.action === 'reword') {
      await this._runGit(['commit', '--amend', '-m', item.message]);
      return;
    }
    if (!['squash', 'fixup'].includes(item.action)) return;
    const currentMessage = (await this._runGit(['log', '-1', '--format=%B'])).stdout.trim();
    await this._runGit(['reset', '--soft', 'HEAD~1']);
    const message = item.action === 'fixup'
      ? state.previousMessage
      : `${state.previousMessage}\n\n${item.message || currentMessage}`.trim();
    await this._runGit(['commit', '--amend', '-m', message]);
  }

  async continueInteractiveRebase() {
    const state = this._readRebasePlan();
    if (!state) throw new Error('There is no KitsuneGIT interactive rebase to continue');
    const operation = await this._nativeOperationType();
    if (operation === 'cherry-pick') await this._runGit(['-c', 'core.editor=true', 'cherry-pick', '--continue']);
    const item = state.plan[state.index];
    if (state.phase === 'cherry-picking' && item) {
      await this._finalizeRebasePlanItem(state, item);
      state.index += 1;
      state.phase = null;
      state.previousMessage = '';
      this._writeRebasePlan(state);
    }
    return await this._runRebasePlan(state);
  }

  async abortInteractiveRebase() {
    const state = this._readRebasePlan();
    if (!state) throw new Error('There is no KitsuneGIT interactive rebase to abort');
    if (await this._nativeOperationType() === 'cherry-pick') {
      await this._runGit(['cherry-pick', '--abort'], { rejectOnError: false });
    }
    await this._runGit(['reset', '--hard', assertRevision(state.originalHead)]);
    this._removeRebasePlan();
    return await this.getStatus();
  }

  _rebasePlanPath() {
    const value = fs.realpathSync(this.repoPath);
    const dotGit = path.join(value, '.git');
    if (fs.statSync(dotGit, { throwIfNoEntry: false })?.isDirectory()) return path.join(dotGit, 'kitsune-rebase-plan.json');
    const gitFile = fs.readFileSync(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/i.exec(gitFile);
    if (!match) throw new Error('Unable to resolve repository metadata directory');
    const gitDirectory = path.resolve(value, match[1]);
    return path.join(gitDirectory, 'kitsune-rebase-plan.json');
  }

  _writeRebasePlan(state) {
    const target = this._rebasePlanPath();
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform === 'win32') fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
  }

  _readRebasePlan() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._rebasePlanPath(), 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.plan) || !Number.isSafeInteger(parsed.index)) return null;
      return parsed;
    } catch { return null; }
  }

  _removeRebasePlan() {
    fs.rmSync(this._rebasePlanPath(), { force: true });
  }

  async resolveConflictUsing(filePath, side) {
    if (!['ours', 'theirs'].includes(side)) throw new Error('Conflict side must be ours or theirs');
    const safePath = normalizeRelativePath(this.repoPath, filePath);
    await this.git.raw(['checkout', `--${side}`, '--', literalPathspec(this.repoPath, safePath)]);
    await this.git.add([literalPathspec(this.repoPath, safePath)]);
    return await this.getStatus();
  }

  async continueOperation() {
    const operation = await this.getOperationState();
    if (operation.conflicted.length) throw new Error('Resolve and stage every conflict before continuing');
    if (operation.type === 'interactive-rebase') return await this.continueInteractiveRebase();
    const commands = {
      rebase: ['-c', 'core.editor=true', 'rebase', '--continue'],
      merge: ['-c', 'core.editor=true', 'commit', '--no-edit'],
      'cherry-pick': ['-c', 'core.editor=true', 'cherry-pick', '--continue'],
      revert: ['-c', 'core.editor=true', 'revert', '--continue'],
      am: ['-c', 'core.editor=true', 'am', '--continue']
    };
    if (!commands[operation.type]) throw new Error('There is no supported Git operation to continue');
    await this._runGit(commands[operation.type]);
    return await this.getStatus();
  }

  async abortOperation() {
    const operation = await this.getOperationState();
    if (operation.type === 'interactive-rebase') return await this.abortInteractiveRebase();
    const commands = {
      rebase: ['rebase', '--abort'],
      merge: ['merge', '--abort'],
      'cherry-pick': ['cherry-pick', '--abort'],
      revert: ['revert', '--abort'],
      am: ['am', '--abort'],
      bisect: ['bisect', 'reset']
    };
    if (!commands[operation.type]) throw new Error('There is no supported Git operation to abort');
    await this.git.raw(commands[operation.type]);
    return await this.getStatus();
  }

  async getBranchDiffStats(from, to) {
    const safeFrom = assertRefName(from, 'Base branch');
    const safeTo = assertRefName(to, 'Compared branch');
    const raw = await this.git.diff(['--numstat', `${safeFrom}..${safeTo}`]);
    return this._parseNumstat(raw);
  }

  // ─── Worktrees ──────────────────────────────────────────

  async getWorktrees() {
    const result = await this._runGit(['worktree', 'list', '--porcelain', '-z']);
    const records = [];
    let current = null;
    for (const field of result.stdout.split('\0')) {
      if (!field) {
        if (current) records.push(current);
        current = null;
        continue;
      }
      const separator = field.indexOf(' ');
      const key = separator < 0 ? field : field.slice(0, separator);
      const value = separator < 0 ? true : field.slice(separator + 1);
      if (key === 'worktree') {
        if (current) records.push(current);
        current = { path: value, head: null, branch: null, bare: false, detached: false, locked: null, prunable: null };
      } else if (current) {
        if (key === 'HEAD') current.head = value;
        else if (key === 'branch') current.branch = String(value).replace(/^refs\/heads\//, '');
        else if (key === 'bare' || key === 'detached') current[key] = true;
        else if (key === 'locked' || key === 'prunable') current[key] = value === true ? '' : value;
      }
    }
    if (current) records.push(current);
    return records;
  }

  async addWorktree(input) {
    if (!input || typeof input !== 'object') throw new Error('Worktree options are required');
    const target = normalizeRepositoryPath(input.path, { mustExist: false });
    const repositoryRoot = fs.realpathSync(this.repoPath);
    const gitDirectory = path.resolve(repositoryRoot, '.git');
    if (target === repositoryRoot || target === gitDirectory || target.startsWith(`${gitDirectory}${path.sep}`)) {
      throw new Error('Worktree path cannot be the current repository or its .git directory');
    }
    const args = ['worktree', 'add'];
    if (input.detach === true) args.push('--detach');
    if (input.newBranch) args.push('-b', assertRefName(input.newBranch, 'New worktree branch'));
    args.push(target);
    if (input.startPoint) args.push(assertRefName(input.startPoint, 'Worktree start point'));
    else if (input.branch) args.push(assertRefName(input.branch, 'Worktree branch'));
    await this._runGit(args, { timeoutMs: 5 * 60_000 });
    return await this.getWorktrees();
  }

  async removeWorktree(targetPath, force = false) {
    const target = normalizeRepositoryPath(targetPath);
    const worktrees = await this.getWorktrees();
    const match = worktrees.find(item => path.resolve(item.path) === target);
    if (!match || path.resolve(match.path) === path.resolve(this.repoPath)) {
      throw new Error('Only an attached secondary worktree can be removed');
    }
    const args = ['worktree', 'remove'];
    if (force === true) args.push('--force');
    args.push(target);
    await this._runGit(args, { timeoutMs: 5 * 60_000 });
    return await this.getWorktrees();
  }

  async pruneWorktrees() {
    await this._runGit(['worktree', 'prune', '--verbose']);
    return await this.getWorktrees();
  }

  // ─── Reflog and recovery ────────────────────────────────

  async getReflog(maxCount = 200) {
    const count = normalizeMaxCount(maxCount, 200, 1000);
    const result = await this._runGit([
      'reflog', 'show', '--all', '--date=iso-strict', `--max-count=${count}`,
      '--format=%H%x00%h%x00%gd%x00%gs%x00%aI%x00%aN%x1e'
    ]);
    return result.stdout.split('\x1e').map(record => record.replace(/^\r?\n|\r?\n$/g, '')).filter(Boolean).map(record => {
      const [hash, hashShort, selector, message, date, author] = record.split('\0');
      return { hash, hashShort, selector, message, date, author };
    }).filter(entry => /^[0-9a-f]{40,64}$/i.test(entry.hash || ''));
  }

  async recoverToBranch(hash, branchName) {
    const safeHash = assertRevision(hash);
    const safeBranch = assertRefName(branchName, 'Recovery branch');
    await this._runGit(['branch', safeBranch, safeHash]);
    return await this.getBranches();
  }

  // ─── Bisect ─────────────────────────────────────────────

  async getBisectStatus() {
    const operation = await this.getOperationState();
    if (operation.type !== 'bisect') return { active: false, log: '', current: null };
    const [log, current] = await Promise.all([
      this._runGit(['bisect', 'log'], { rejectOnError: false, maxOutput: 512 * 1024 }),
      this._runGit(['rev-parse', 'HEAD'])
    ]);
    return { active: true, log: log.stdout.trim(), current: current.stdout.trim() };
  }

  async startBisect(goodHash, badHash) {
    const good = assertRevision(goodHash, 'Known good commit');
    const bad = assertRevision(badHash, 'Known bad commit');
    await this._runGit(['bisect', 'start', bad, good]);
    return await this.getBisectStatus();
  }

  async markBisect(result) {
    if (!['good', 'bad', 'skip'].includes(result)) throw new Error('Bisect result must be good, bad, or skip');
    const output = await this._runGit(['bisect', result], { rejectOnError: false, maxOutput: 512 * 1024 });
    const status = await this.getBisectStatus();
    return { ...status, output: `${output.stdout}\n${output.stderr}`.trim() };
  }

  async resetBisect() {
    await this._runGit(['bisect', 'reset']);
    return await this.getBisectStatus();
  }

  // ─── Portable patches ───────────────────────────────────

  async createMailboxPatch(hash) {
    const result = await this._runGit(['format-patch', '--stdout', '--binary', '-1', assertRevision(hash)], {
      timeoutMs: 2 * 60_000,
      maxOutput: 64 * 1024 * 1024
    });
    return result.stdout;
  }

  async applyMailboxPatch(content) {
    if (typeof content !== 'string' || !content || content.length > 64 * 1024 * 1024 || content.includes('\0')) {
      throw new Error('Patch file is empty, binary, or too large');
    }
    await this._runGit(['am', '--3way', '--keep-cr'], { input: content, timeoutMs: 5 * 60_000, maxOutput: 8 * 1024 * 1024 });
    return await this.getStatus();
  }

  // ─── Git LFS ────────────────────────────────────────────

  async getLfsStatus() {
    const version = await this._runGit(['lfs', 'version'], { rejectOnError: false, maxOutput: 128 * 1024 });
    if (version.code !== 0) return { available: false, version: null, trackedPatterns: [], files: [] };
    const attributesPath = path.join(this.repoPath, '.gitattributes');
    let attributes = '';
    try { attributes = fs.readFileSync(attributesPath, 'utf8'); } catch { /* no attributes */ }
    const trackedPatterns = attributes.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && /filter=lfs/.test(line)).map(line => line.split(/\s+/)[0]);
    const filesResult = await this._runGit(['lfs', 'ls-files', '--name-only'], { rejectOnError: false, maxOutput: 4 * 1024 * 1024 });
    return {
      available: true,
      version: (version.stdout || version.stderr).trim(),
      trackedPatterns,
      files: filesResult.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 10_000)
    };
  }

  async initializeLfs() {
    await this._runGit(['lfs', 'install', '--local']);
    return await this.getLfsStatus();
  }

  async trackLfs(pattern, enabled = true) {
    const safePattern = assertSingleLine(pattern, 'LFS pattern', { maxLength: 1024 });
    if (safePattern.startsWith('-')) throw new Error('LFS pattern cannot begin with a hyphen');
    await this._runGit(['lfs', enabled ? 'track' : 'untrack', safePattern]);
    return await this.getLfsStatus();
  }

  // ─── Sparse checkout ────────────────────────────────────

  async getSparseStatus() {
    const enabled = await this._runGit(['config', '--bool', '--get', 'core.sparseCheckout'], { rejectOnError: false, maxOutput: 64 * 1024 });
    if (enabled.stdout.trim() !== 'true') return { enabled: false, paths: [] };
    const listed = await this._runGit(['sparse-checkout', 'list'], { rejectOnError: false, maxOutput: 4 * 1024 * 1024 });
    return { enabled: true, paths: listed.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean) };
  }

  async setSparsePaths(paths) {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 1000) throw new Error('Sparse checkout requires 1-1000 directory paths');
    const normalized = [...new Set(paths.map(value => normalizeRelativePath(this.repoPath, value, 'Sparse directory')))];
    await this._runGit(['sparse-checkout', 'set', '--cone', '--stdin'], { input: `${normalized.join('\n')}\n`, timeoutMs: 5 * 60_000 });
    return await this.getSparseStatus();
  }

  async disableSparseCheckout() {
    await this._runGit(['sparse-checkout', 'disable'], { timeoutMs: 5 * 60_000 });
    return await this.getSparseStatus();
  }

  // ─── Repository maintenance ─────────────────────────────

  async getMaintenanceStatus() {
    const [auto, strategy] = await Promise.all([
      this._runGit(['config', '--local', '--get', 'maintenance.auto'], { rejectOnError: false, maxOutput: 64 * 1024 }),
      this._runGit(['config', '--local', '--get', 'maintenance.strategy'], { rejectOnError: false, maxOutput: 64 * 1024 })
    ]);
    return { auto: auto.stdout.trim() || null, strategy: strategy.stdout.trim() || null };
  }

  async getRepositoryOverview() {
    const [commitCount, objects, contributors] = await Promise.all([
      this._runGit(['rev-list', '--count', '--all'], { rejectOnError: false, maxOutput: 64 * 1024 }),
      this._runGit(['count-objects', '-vH'], { rejectOnError: false, maxOutput: 128 * 1024 }),
      this._runGit(['shortlog', '-sne', '--all'], { rejectOnError: false, maxOutput: 2 * 1024 * 1024 })
    ]);
    const objectStats = {};
    for (const line of objects.stdout.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator > 0) objectStats[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    const topContributors = contributors.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 10).map(line => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      return match ? { commits: Number(match[1]), identity: match[2].slice(0, 512) } : null;
    }).filter(Boolean);
    return {
      commits: Number.parseInt(commitCount.stdout.trim(), 10) || 0,
      objects: objectStats,
      contributors: topContributors
    };
  }

  async runMaintenance() {
    const result = await this._runGit(['maintenance', 'run'], { timeoutMs: 15 * 60_000, maxOutput: 4 * 1024 * 1024 });
    return { status: await this.getMaintenanceStatus(), output: `${result.stdout}\n${result.stderr}`.trim() };
  }

  async setMaintenance(enabled) {
    await this._runGit(['maintenance', enabled === true ? 'start' : 'stop'], { timeoutMs: 2 * 60_000 });
    return await this.getMaintenanceStatus();
  }

  // ─── GitFlow ─────────────────────────────────────────────

  /**
   * Get GitFlow configuration from git config.
   * Returns null if GitFlow is not initialized.
   */
  async getGitFlowConfig() {
    try {
      const result = await this.git.raw(['config', '--list', '--local']);
      const config = {};
      result.trim().split('\n').forEach(line => {
        const idx = line.indexOf('=');
        if (idx > 0) config[line.substring(0, idx)] = line.substring(idx + 1);
      });
      // Check if gitflow is configured
      const master = config['gitflow.branch.master'] || config['gitflow.branch.main'] || null;
      const develop = config['gitflow.branch.develop'] || null;
      if (!master && !develop) return null;
      const parsed = {
        master: master || 'main',
        develop: develop || 'develop',
        featurePrefix: config['gitflow.prefix.feature'] || 'feature/',
        releasePrefix: config['gitflow.prefix.release'] || 'release/',
        hotfixPrefix: config['gitflow.prefix.hotfix'] || 'hotfix/',
        supportPrefix: config['gitflow.prefix.support'] || 'support/',
        versionTagPrefix: config['gitflow.prefix.versiontag'] || ''
      };
      assertRefName(parsed.master, 'GitFlow production branch');
      assertRefName(parsed.develop, 'GitFlow development branch');
      assertRefName(`${parsed.featurePrefix}example`, 'GitFlow feature prefix');
      assertRefName(`${parsed.releasePrefix}1.0.0`, 'GitFlow release prefix');
      assertRefName(`${parsed.hotfixPrefix}1.0.1`, 'GitFlow hotfix prefix');
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Initialize GitFlow in the repository.
   * Sets up the branch naming conventions in git config.
   */
  async gitFlowInit(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('GitFlow options must be an object');
    }
    const master = assertRefName(options.master || 'main', 'Production branch');
    const develop = assertRefName(options.develop || 'develop', 'Development branch');
    const featurePrefix = assertSingleLine(options.featurePrefix || 'feature/', 'Feature prefix');
    const releasePrefix = assertSingleLine(options.releasePrefix || 'release/', 'Release prefix');
    const hotfixPrefix = assertSingleLine(options.hotfixPrefix || 'hotfix/', 'Hotfix prefix');
    const versionTagPrefix = assertSingleLine(options.versionTagPrefix || '', 'Version tag prefix', { allowEmpty: true });
    assertRefName(`${featurePrefix}example`, 'Feature prefix');
    assertRefName(`${releasePrefix}1.0.0`, 'Release prefix');
    assertRefName(`${hotfixPrefix}1.0.1`, 'Hotfix prefix');
    assertRefName(`${versionTagPrefix}1.0.0`, 'Version tag prefix');

    // An unborn repository needs a commit before branches can be created.
    try {
      await this.git.raw(['rev-parse', '--verify', 'HEAD']);
    } catch {
      await this.git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);
    }

    let branches = await this.git.branchLocal();
    if (!branches.all.includes(master)) {
      await this.git.branch([master, 'HEAD']);
    }
    branches = await this.git.branchLocal();
    if (!branches.all.includes(develop)) {
      await this.git.branch([develop, master]);
    }
    await this.git.checkout(develop);

    // Persist configuration only after the branch setup succeeds.
    await this.git.raw(['config', '--local', 'gitflow.branch.master', master]);
    await this.git.raw(['config', '--local', 'gitflow.branch.develop', develop]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.feature', featurePrefix]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.release', releasePrefix]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.hotfix', hotfixPrefix]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.support', 'support/']);
    await this.git.raw(['config', '--local', 'gitflow.prefix.versiontag', versionTagPrefix]);
    return await this.getGitFlowConfig();
  }

  /**
   * Start a new feature branch from develop.
   */
  async gitFlowFeatureStart(name) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized. Run GitFlow Init first.');
    const branchName = assertRefName(cfg.featurePrefix + assertSingleLine(name, 'Feature name'), 'Feature branch');
    await this.git.checkoutBranch(branchName, cfg.develop);
    return await this.getStatus();
  }

  /**
   * Finish a feature: merge into develop and delete the feature branch.
   */
  async gitFlowFeatureFinish(name) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const safeName = assertSingleLine(name, 'Feature name');
    const branchName = assertRefName(cfg.featurePrefix + safeName, 'Feature branch');

    await this._assertCleanWorkingTree();

    // Switch to develop
    await this.git.checkout(cfg.develop);
    // Merge feature with --no-ff
    await this.git.merge(['--no-ff', '-m', `Merge feature '${safeName}' into ${cfg.develop}`, branchName]);
    // Delete feature branch
    await this.git.branch(['-d', branchName]);
    return await this.getStatus();
  }

  /**
   * Start a new release branch from develop.
   */
  async gitFlowReleaseStart(version) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const branchName = assertRefName(cfg.releasePrefix + assertSingleLine(version, 'Release version'), 'Release branch');
    await this.git.checkoutBranch(branchName, cfg.develop);
    return await this.getStatus();
  }

  /**
   * Finish a release: merge into master and develop, tag, delete branch.
   */
  async gitFlowReleaseFinish(version, tagMessage) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const safeVersion = assertSingleLine(version, 'Release version');
    const branchName = assertRefName(cfg.releasePrefix + safeVersion, 'Release branch');
    const tagName = assertRefName(cfg.versionTagPrefix + safeVersion, 'Release tag');
    const safeTagMessage = tagMessage ? assertMessage(tagMessage, 'Tag message') : `Release ${safeVersion}`;

    await this._assertCleanWorkingTree();
    if ((await this.getTags()).includes(tagName)) throw new Error(`Tag already exists: ${tagName}`);

    // Merge into master
    await this.git.checkout(cfg.master);
    await this.git.merge(['--no-ff', '-m', `Merge release '${safeVersion}' into ${cfg.master}`, branchName]);

    // Tag the release
    await this.git.tag(['-a', tagName, '-m', safeTagMessage]);

    // Merge back into develop
    await this.git.checkout(cfg.develop);
    await this.git.merge(['--no-ff', '-m', `Merge release '${safeVersion}' back into ${cfg.develop}`, branchName]);

    // Delete release branch
    await this.git.branch(['-d', branchName]);

    // Stay on develop
    return await this.getStatus();
  }

  /**
   * Start a hotfix branch from master.
   */
  async gitFlowHotfixStart(version) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const branchName = assertRefName(cfg.hotfixPrefix + assertSingleLine(version, 'Hotfix version'), 'Hotfix branch');
    await this.git.checkoutBranch(branchName, cfg.master);
    return await this.getStatus();
  }

  /**
   * Finish a hotfix: merge into master and develop, tag, delete branch.
   */
  async gitFlowHotfixFinish(version, tagMessage) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const safeVersion = assertSingleLine(version, 'Hotfix version');
    const branchName = assertRefName(cfg.hotfixPrefix + safeVersion, 'Hotfix branch');
    const tagName = assertRefName(cfg.versionTagPrefix + safeVersion, 'Hotfix tag');
    const safeTagMessage = tagMessage ? assertMessage(tagMessage, 'Tag message') : `Hotfix ${safeVersion}`;

    await this._assertCleanWorkingTree();
    if ((await this.getTags()).includes(tagName)) throw new Error(`Tag already exists: ${tagName}`);

    // Merge into master
    await this.git.checkout(cfg.master);
    await this.git.merge(['--no-ff', '-m', `Merge hotfix '${safeVersion}' into ${cfg.master}`, branchName]);

    // Tag
    await this.git.tag(['-a', tagName, '-m', safeTagMessage]);

    // Merge back into develop
    await this.git.checkout(cfg.develop);
    await this.git.merge(['--no-ff', '-m', `Merge hotfix '${safeVersion}' back into ${cfg.develop}`, branchName]);

    // Delete hotfix branch
    await this.git.branch(['-d', branchName]);

    return await this.getStatus();
  }

  /**
   * List active gitflow branches by type.
   */
  async getGitFlowBranches() {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) return null;
    const branches = await this.git.branchLocal();
    const features = branches.all.filter(b => b.startsWith(cfg.featurePrefix)).map(b => b.substring(cfg.featurePrefix.length));
    const releases = branches.all.filter(b => b.startsWith(cfg.releasePrefix)).map(b => b.substring(cfg.releasePrefix.length));
    const hotfixes = branches.all.filter(b => b.startsWith(cfg.hotfixPrefix)).map(b => b.substring(cfg.hotfixPrefix.length));
    return { config: cfg, features, releases, hotfixes, current: branches.current };
  }

  // ─── Push with upstream ──────────────────────────────────

  async pushWithUpstream(remote = 'origin', branch) {
    const branchName = branch || (await this.git.branchLocal()).current;
    await this.git.push(
      assertRemoteName(remote || 'origin'),
      assertRefName(branchName, 'Branch name'),
      ['--set-upstream']
    );
    return await this.getStatus();
  }

  // ─── Helpers ────────────────────────────────────────────

  async _assertCleanWorkingTree() {
    const status = await this.git.status();
    if (!status.isClean()) {
      throw new Error('GitFlow finish requires a clean working tree');
    }
  }

  _parseLog(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split('\x1e').map(record => record.replace(/^[\r\n]+|[\r\n]+$/g, '')).filter(Boolean).map(record => {
      const fields = record.split('\0');
      if (fields.length !== 8) throw new Error('Unexpected Git log output');
      return {
        hash: fields[0],
        hashShort: fields[1],
        date: fields[2],
        message: fields[3],
        author: fields[4],
        email: fields[5],
        refs: fields[6],
        parents: fields[7] ? fields[7].split(' ').filter(Boolean) : []
      };
    });
  }

  _parseNumstat(raw) {
    if (!raw || !raw.trim()) return [];
    const lines = raw.trim().split('\n');
    const stats = [];
    for (const line of lines) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match) {
        stats.push({
          added: match[1] === '-' ? 0 : parseInt(match[1]),
          deleted: match[2] === '-' ? 0 : parseInt(match[2]),
          path: match[3]
        });
      }
    }
    return stats;
  }

  _parseBlame(raw) {
    const lines = raw.split('\n');
    const result = [];
    let current = {};

    for (const line of lines) {
      if (/^[0-9a-f]{40}\s/.test(line)) {
        const parts = line.split(' ');
        current = { hash: parts[0], originalLine: parts[1], finalLine: parts[2] };
      } else if (line.startsWith('author ')) {
        current.author = line.substring(7);
      } else if (line.startsWith('author-time ')) {
        current.timestamp = parseInt(line.substring(12));
      } else if (line.startsWith('summary ')) {
        current.summary = line.substring(8);
      } else if (line.startsWith('\t')) {
        current.content = line.substring(1);
        result.push({ ...current });
      }
    }
    return result;
  }
}

module.exports = GitService;
