const simpleGit = require('simple-git');
const path = require('path');

class GitService {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  // ─── Repository ──────────────────────────────────────────

  async init() {
    await this.git.init();
    return await this.getStatus();
  }

  async clone(url, targetPath) {
    await simpleGit().clone(url, targetPath);
    this.repoPath = targetPath;
    this.git = simpleGit(targetPath);
    return await this.getStatus();
  }

  // ─── Status ──────────────────────────────────────────────

  async getStatus() {
    const status = await this.git.status();
    const branchSummary = await this.git.branchLocal();
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
      const raw = await this.git.raw([
        'log', '--all', '--decorate', `--max-count=${maxCount}`,
        '--format=%H%n%h%n%aI%n%s%n%aN%n%aE%n%D%n%P'
      ]);
      if (!raw || !raw.trim()) return [];
      const entries = raw.trim().split('\n');
      const commits = [];
      for (let i = 0; i + 7 < entries.length; i += 8) {
        commits.push({
          hash: entries[i],
          hashShort: entries[i + 1],
          date: entries[i + 2],
          message: entries[i + 3],
          author: entries[i + 4],
          email: entries[i + 5],
          refs: entries[i + 6],
          parents: entries[i + 7] ? entries[i + 7].split(' ').filter(Boolean) : []
        });
      }
      return commits;
    } catch {
      return [];
    }
  }

  // ─── Diff ────────────────────────────────────────────────

  async getDiff(filePath) {
    if (filePath) {
      return await this.git.diff([filePath]);
    }
    return await this.git.diff();
  }

  async getDiffCached(filePath) {
    if (filePath) {
      return await this.git.diff(['--cached', filePath]);
    }
    return await this.git.diff(['--cached']);
  }

  // ─── Staging ─────────────────────────────────────────────

  async stage(files) {
    await this.git.add(files);
    return await this.getStatus();
  }

  async unstage(files) {
    await this.git.reset(['HEAD', '--', ...files]);
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
    const options = amend ? { '--amend': null } : {};
    await this.git.commit(message, undefined, options);
    return await this.getStatus();
  }

  // ─── Push / Pull / Fetch ─────────────────────────────────

  async push(remote = 'origin', branch, force = false) {
    const options = force ? ['--force'] : [];
    if (branch) {
      await this.git.push(remote, branch, options);
    } else {
      await this.git.push(remote, undefined, options);
    }
    return await this.getStatus();
  }

  async pull(remote = 'origin', branch, rebase = false) {
    const options = {};
    if (rebase) options['--rebase'] = null;
    if (branch) {
      await this.git.pull(remote, branch, options);
    } else {
      await this.git.pull(remote, undefined, options);
    }
    return await this.getStatus();
  }

  async fetch(remote, prune = false) {
    const options = prune ? ['--prune'] : [];
    if (remote) {
      await this.git.fetch(remote, undefined, options);
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
    if (startPoint) {
      await this.git.checkoutBranch(name, startPoint);
    } else {
      await this.git.checkoutLocalBranch(name);
    }
    return await this.getBranches();
  }

  async deleteBranch(name, force = false) {
    if (force) {
      await this.git.branch(['-D', name]);
    } else {
      await this.git.branch(['-d', name]);
    }
    return await this.getBranches();
  }

  async checkout(branch) {
    await this.git.checkout(branch);
    return await this.getStatus();
  }

  // ─── Merge / Rebase ──────────────────────────────────────

  async merge(branch, noFf = false) {
    const options = noFf ? ['--no-ff'] : [];
    await this.git.merge([branch, ...options]);
    return await this.getStatus();
  }

  async rebase(branch) {
    await this.git.rebase([branch]);
    return await this.getStatus();
  }

  async rebaseAbort() {
    await this.git.rebase(['--abort']);
    return await this.getStatus();
  }

  async rebaseContinue() {
    await this.git.rebase(['--continue']);
    return await this.getStatus();
  }

  // ─── Tags ───────────────────────────────────────────────

  async getTags() {
    const tags = await this.git.tags();
    return tags.all;
  }

  async createTag(name, message, commitHash) {
    if (message) {
      const args = ['-a', name, '-m', message];
      if (commitHash) args.push(commitHash);
      await this.git.tag(args);
    } else {
      const args = [name];
      if (commitHash) args.push(commitHash);
      await this.git.tag(args);
    }
    return await this.getTags();
  }

  async deleteTag(name) {
    await this.git.tag(['-d', name]);
    return await this.getTags();
  }

  async pushTag(name, remote = 'origin') {
    await this.git.push(remote, name);
    return await this.getTags();
  }

  // ─── Stash ──────────────────────────────────────────────

  async stash(message, includeUntracked = false) {
    const args = ['push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message) { args.push('-m', message); }
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
    await this.git.stash(['pop', `stash@{${index}}`]);
    return await this.getStatus();
  }

  async stashApply(index = 0) {
    await this.git.stash(['apply', `stash@{${index}}`]);
    return await this.getStatus();
  }

  async stashDrop(index = 0) {
    await this.git.stash(['drop', `stash@{${index}}`]);
    return await this.stashList();
  }

  // ─── Remotes ────────────────────────────────────────────

  async getRemotes() {
    return await this.git.getRemotes(true);
  }

  async addRemote(name, url) {
    await this.git.addRemote(name, url);
    return await this.getRemotes();
  }

  async removeRemote(name) {
    await this.git.removeRemote(name);
    return await this.getRemotes();
  }

  // ─── Advanced Operations ────────────────────────────────

  async cherryPick(hash) {
    await this.git.raw(['cherry-pick', hash]);
    return await this.getStatus();
  }

  async revert(hash) {
    await this.git.revert(hash);
    return await this.getStatus();
  }

  async reset(hash, mode = '--mixed') {
    const validModes = ['--soft', '--mixed', '--hard'];
    if (!validModes.includes(mode)) {
      throw new Error('Invalid reset mode');
    }
    await this.git.reset([mode, hash]);
    return await this.getStatus();
  }

  async blame(filePath) {
    const result = await this.git.raw(['blame', '--porcelain', filePath]);
    return this._parseBlame(result);
  }

  async showCommit(hash) {
    const result = await this.git.show([hash, '--stat', '--format=fuller']);
    const diffResult = await this.git.show([hash, '--format=']);
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
    await this.git.checkout(['--', filePath]);
    return await this.getStatus();
  }

  async discardUntracked(filePath) {
    await this.git.clean('f', [filePath]);
    return await this.getStatus();
  }

  async addToGitignore(pattern) {
    const fs = require('fs');
    const gitignorePath = path.join(this.repoPath, '.gitignore');
    let content = '';
    try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* no .gitignore yet */ }
    if (content && !content.endsWith('\n')) content += '\n';
    content += pattern + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf8');
    return await this.getStatus();
  }

  async discardAllChanges() {
    await this.git.checkout(['--', '.']);
    await this.git.clean('f', ['-d']);
    return await this.getStatus();
  }

  async getFileHistory(filePath) {
    const log = await this.git.log({ file: filePath, maxCount: 100 });
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
      const result = await this.git.diff(['--stat', '--numstat']);
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
        const match = line.match(/^[\s+-]?([0-9a-f]+)\s+(\S+)(?:\s+\((.+)\))?/);
        if (!match) return null;
        return { hash: match[1], path: match[2], describe: match[3] || '' };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  async updateSubmodule(submodulePath) {
    await this.git.raw(['submodule', 'update', '--init', '--recursive', submodulePath || '']);
    return await this.getSubmodules();
  }

  // ─── Git Config ────────────────────────────────────────

  async getConfig() {
    const result = await this.git.raw(['config', '--list', '--local']);
    const config = {};
    result.trim().split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) {
        config[line.substring(0, idx)] = line.substring(idx + 1);
      }
    });
    return config;
  }

  async setConfig(key, value) {
    const allowedKeys = ['user.name', 'user.email', 'core.autocrlf', 'core.ignorecase',
      'pull.rebase', 'push.default', 'merge.ff', 'core.editor'];
    if (!allowedKeys.includes(key)) throw new Error('Config key not allowed');
    await this.git.raw(['config', '--local', key, value]);
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
      return await this.git.show([`${hash}`, '--', filePath]);
    } catch {
      return '';
    }
  }

  // ─── Branch Rename ─────────────────────────────────────

  async renameBranch(oldName, newName) {
    await this.git.branch(['-m', oldName, newName]);
    return await this.getBranches();
  }

  // ─── Search Log ────────────────────────────────────────

  async searchLog(query, maxCount = 200) {
    try {
      const raw = await this.git.raw([
        'log', '--all', '--decorate', `--max-count=${maxCount}`,
        '--format=%H%n%h%n%aI%n%s%n%aN%n%aE%n%D%n%P',
        `--grep=${query}`
      ]);
      if (!raw || !raw.trim()) return [];
      const entries = raw.trim().split('\n');
      const commits = [];
      for (let i = 0; i + 7 < entries.length; i += 8) {
        commits.push({
          hash: entries[i],
          hashShort: entries[i + 1],
          date: entries[i + 2],
          message: entries[i + 3],
          author: entries[i + 4],
          email: entries[i + 5],
          refs: entries[i + 6],
          parents: entries[i + 7] ? entries[i + 7].split(' ').filter(Boolean) : []
        });
      }
      return commits;
    } catch {
      return [];
    }
  }

  // ─── Commit Files List ────────────────────────────────

  async getCommitFiles(hash) {
    try {
      const result = await this.git.raw(['diff-tree', '--no-commit-id', '-r', '--name-status', hash]);
      return result.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { status: parts[0], path: parts[1], oldPath: parts[2] || null };
      });
    } catch {
      return [];
    }
  }

  // ─── Branch Comparison ────────────────────────────────────

  async getBranchDiff(from, to) {
    return await this.git.diff([`${from}..${to}`]);
  }

  async getBranchDiffStats(from, to) {
    const raw = await this.git.diff(['--numstat', `${from}..${to}`]);
    return this._parseNumstat(raw);
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
      return {
        master: master || 'main',
        develop: develop || 'develop',
        featurePrefix: config['gitflow.prefix.feature'] || 'feature/',
        releasePrefix: config['gitflow.prefix.release'] || 'release/',
        hotfixPrefix: config['gitflow.prefix.hotfix'] || 'hotfix/',
        supportPrefix: config['gitflow.prefix.support'] || 'support/',
        versionTagPrefix: config['gitflow.prefix.versiontag'] || ''
      };
    } catch {
      return null;
    }
  }

  /**
   * Initialize GitFlow in the repository.
   * Sets up the branch naming conventions in git config.
   */
  async gitFlowInit(options = {}) {
    const master = options.master || 'main';
    const develop = options.develop || 'develop';
    const featurePrefix = options.featurePrefix || 'feature/';
    const releasePrefix = options.releasePrefix || 'release/';
    const hotfixPrefix = options.hotfixPrefix || 'hotfix/';
    const versionTagPrefix = options.versionTagPrefix || '';

    // Set gitflow config
    await this.git.raw(['config', '--local', 'gitflow.branch.master', master]);
    await this.git.raw(['config', '--local', 'gitflow.branch.develop', develop]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.feature', featurePrefix]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.release', releasePrefix]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.hotfix', hotfixPrefix]);
    await this.git.raw(['config', '--local', 'gitflow.prefix.support', 'support/']);
    await this.git.raw(['config', '--local', 'gitflow.prefix.versiontag', versionTagPrefix]);

    // Create develop branch if it doesn't exist
    const branches = await this.git.branchLocal();
    if (!branches.all.includes(develop)) {
      // Make sure master/main exists
      if (branches.all.includes(master)) {
        await this.git.branch([develop, master]);
      } else {
        // If no commits yet, create initial commit first
        try {
          await this.git.raw(['rev-parse', 'HEAD']);
        } catch {
          // No commits — create an empty initial commit
          await this.git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);
        }
        // Rename current branch to master if needed
        if (branches.current !== master && branches.all.length > 0) {
          await this.git.branch(['-m', branches.current, master]);
        }
        await this.git.branch([develop, master]);
      }
    }

    // Checkout develop
    await this.git.checkout(develop);
    return await this.getGitFlowConfig();
  }

  /**
   * Start a new feature branch from develop.
   */
  async gitFlowFeatureStart(name) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized. Run GitFlow Init first.');
    const branchName = cfg.featurePrefix + name;
    await this.git.checkoutBranch(branchName, cfg.develop);
    return await this.getStatus();
  }

  /**
   * Finish a feature: merge into develop and delete the feature branch.
   */
  async gitFlowFeatureFinish(name) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const branchName = cfg.featurePrefix + name;

    // Switch to develop
    await this.git.checkout(cfg.develop);
    // Merge feature with --no-ff
    await this.git.merge([branchName, '--no-ff', '-m', `Merge feature '${name}' into ${cfg.develop}`]);
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
    const branchName = cfg.releasePrefix + version;
    await this.git.checkoutBranch(branchName, cfg.develop);
    return await this.getStatus();
  }

  /**
   * Finish a release: merge into master and develop, tag, delete branch.
   */
  async gitFlowReleaseFinish(version, tagMessage) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const branchName = cfg.releasePrefix + version;
    const tagName = cfg.versionTagPrefix + version;

    // Merge into master
    await this.git.checkout(cfg.master);
    await this.git.merge([branchName, '--no-ff', '-m', `Merge release '${version}' into ${cfg.master}`]);

    // Tag the release
    if (tagMessage) {
      await this.git.tag(['-a', tagName, '-m', tagMessage]);
    } else {
      await this.git.tag(['-a', tagName, '-m', `Release ${version}`]);
    }

    // Merge back into develop
    await this.git.checkout(cfg.develop);
    await this.git.merge([branchName, '--no-ff', '-m', `Merge release '${version}' back into ${cfg.develop}`]);

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
    const branchName = cfg.hotfixPrefix + version;
    await this.git.checkoutBranch(branchName, cfg.master);
    return await this.getStatus();
  }

  /**
   * Finish a hotfix: merge into master and develop, tag, delete branch.
   */
  async gitFlowHotfixFinish(version, tagMessage) {
    const cfg = await this.getGitFlowConfig();
    if (!cfg) throw new Error('GitFlow not initialized.');
    const branchName = cfg.hotfixPrefix + version;
    const tagName = cfg.versionTagPrefix + version;

    // Merge into master
    await this.git.checkout(cfg.master);
    await this.git.merge([branchName, '--no-ff', '-m', `Merge hotfix '${version}' into ${cfg.master}`]);

    // Tag
    if (tagMessage) {
      await this.git.tag(['-a', tagName, '-m', tagMessage]);
    } else {
      await this.git.tag(['-a', tagName, '-m', `Hotfix ${version}`]);
    }

    // Merge back into develop
    await this.git.checkout(cfg.develop);
    await this.git.merge([branchName, '--no-ff', '-m', `Merge hotfix '${version}' back into ${cfg.develop}`]);

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
    await this.git.push(remote, branchName, ['--set-upstream']);
    return await this.getStatus();
  }

  // ─── Helpers ────────────────────────────────────────────

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
