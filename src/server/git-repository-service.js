const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { repositoryPath, remoteUrl } = require('./validation');

class GitRepositoryService {
  constructor({ repositoriesPath, gitExecutable = 'git', allowFileRemotes = false }) {
    this.repositoriesPath = path.resolve(repositoriesPath);
    this.gitExecutable = gitExecutable;
    this.allowFileRemotes = allowFileRemotes;
  }

  _installHooks(target) {
    const hook = path.join(target, 'hooks', 'pre-receive');
    fs.copyFileSync(path.join(__dirname, 'pre-receive-hook.js'), hook);
    fs.chmodSync(hook, 0o755);
  }

  installHooks(project) { this._installHooks(this.pathFor(project)); }

  pathFor(project) { return repositoryPath(this.repositoriesPath, project.namespace, project.slug); }

  run(args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitExecutable, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...(options.env || {}) }
      });
      const stdout = [];
      const stderr = [];
      let size = 0;
      const capture = (bucket, chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) child.kill();
        else bucket.push(chunk);
      };
      child.stdout.on('data', chunk => capture(stdout, chunk));
      child.stderr.on('data', chunk => capture(stderr, chunk));
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
      child.once('error', reject);
      child.once('close', code => {
        const output = Buffer.concat(stdout).toString('utf8');
        const error = Buffer.concat(stderr).toString('utf8');
        if (code === 0) resolve({ stdout: output, stderr: error });
        else reject(new Error(`Git operation failed (${code}): ${error.slice(0, 2000) || 'unknown error'}`));
      });
    });
  }

  async create(project) {
    const target = this.pathFor(project);
    if (fs.existsSync(target)) throw new Error('Repository already exists');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await this.run(['init', '--bare', '--initial-branch=main', target]);
    this._installHooks(target);
    return target;
  }

  async import(project, source, authentication = null) {
    const url = remoteUrl(source, { allowFile: this.allowFileRemotes });
    const target = this.pathFor(project);
    if (fs.existsSync(target)) throw new Error('Repository already exists');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const env = authentication?.token ? {
      GIT_ASKPASS: path.join(__dirname, 'git-askpass.js'),
      KITSUNE_IMPORT_TOKEN: authentication.token,
      KITSUNE_IMPORT_USERNAME: authentication.username || 'oauth2'
    } : {};
    await this.run(['clone', '--mirror', url, target], { env });
    this._installHooks(target);
    return target;
  }

  async sync(project, authentication = null) {
    const target = this.pathFor(project);
    const env = authentication?.token ? {
      GIT_ASKPASS: path.join(__dirname, 'git-askpass.js'),
      KITSUNE_IMPORT_TOKEN: authentication.token,
      KITSUNE_IMPORT_USERNAME: authentication.username || 'oauth2'
    } : {};
    await this.run(['remote', 'update', '--prune'], { cwd: target, env });
    return this.summary(project);
  }

  async pushMirror(project, authentication = null) {
    const target = this.pathFor(project);
    const env = authentication?.token ? { GIT_ASKPASS: path.join(__dirname, 'git-askpass.js'), KITSUNE_IMPORT_TOKEN: authentication.token, KITSUNE_IMPORT_USERNAME: authentication.username || 'oauth2' } : {};
    await this.run(['push', '--mirror', 'origin'], { cwd: target, env });
    return this.summary(project);
  }

  _authEnvironment(authentication) { return authentication?.token ? { GIT_ASKPASS: path.join(__dirname, 'git-askpass.js'), KITSUNE_IMPORT_TOKEN: authentication.token, KITSUNE_IMPORT_USERNAME: authentication.username || 'oauth2' } : {}; }
  _mirrorRef(value) { const ref = String(value || ''); if (!/^refs\/(heads|tags|kitsune)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(ref) || ref.includes('..') || ref.includes('//')) throw new Error('Mirror reference is invalid'); return ref; }
  async refMap(project) { const output = await this.run(['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads', 'refs/tags', 'refs/kitsune'], { cwd: this.pathFor(project) }); return Object.fromEntries(output.stdout.split('\n').filter(Boolean).map(line => line.split('\t'))); }
  async remoteRefMap(project, authentication = null) { const output = await this.run(['ls-remote', '--refs', 'origin'], { cwd: this.pathFor(project), env: this._authEnvironment(authentication) }); return Object.fromEntries(output.stdout.split('\n').filter(Boolean).map(line => { const [hash, ref] = line.split(/\s+/); return [ref, hash]; }).filter(([ref]) => /^refs\/(heads|tags|kitsune)\//.test(ref))); }
  async fetchRef(project, ref, authentication = null) { const safe = this._mirrorRef(ref); await this.run(['fetch', 'origin', `+${safe}:${safe}`], { cwd: this.pathFor(project), env: this._authEnvironment(authentication) }); }
  async deleteLocalRef(project, ref) { await this.run(['update-ref', '-d', this._mirrorRef(ref)], { cwd: this.pathFor(project) }); }
  async pushRef(project, ref, deleted = false, authentication = null, force = false) { const safe = this._mirrorRef(ref); const refspec = deleted ? `:${safe}` : `${force ? '+' : ''}${safe}:${safe}`; await this.run(['-c', 'remote.origin.mirror=false', 'push', 'origin', refspec], { cwd: this.pathFor(project), env: this._authEnvironment(authentication) }); }
  async remoteRefMapUrl(project, url, authentication = null) { const safeUrl = remoteUrl(url, { allowFile: this.allowFileRemotes }); const output = await this.run(['ls-remote', '--refs', safeUrl], { cwd: this.pathFor(project), env: this._authEnvironment(authentication) }); return Object.fromEntries(output.stdout.split('\n').filter(Boolean).map(line => { const [hash, ref] = line.split(/\s+/); return [ref, hash]; }).filter(([ref]) => /^refs\/(heads|tags|kitsune)\//.test(ref))); }
  async fetchRefUrl(project, url, ref, authentication = null) { const safe = this._mirrorRef(ref); const safeUrl = remoteUrl(url, { allowFile: this.allowFileRemotes }); await this.run(['fetch', safeUrl, `+${safe}:${safe}`], { cwd: this.pathFor(project), env: this._authEnvironment(authentication) }); }
  async pushRefUrl(project, url, ref, deleted = false, authentication = null, force = false) { const safe = this._mirrorRef(ref); const safeUrl = remoteUrl(url, { allowFile: this.allowFileRemotes }); const refspec = deleted ? `:${safe}` : `${force ? '+' : ''}${safe}:${safe}`; await this.run(['push', safeUrl, refspec], { cwd: this.pathFor(project), env: this._authEnvironment(authentication) }); }

  async summary(project) {
    const target = this.pathFor(project);
    const [refs, count, head] = await Promise.all([
      this.run(['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(committerdate:iso-strict)', 'refs/heads', 'refs/tags'], { cwd: target }),
      this.run(['rev-list', '--all', '--count'], { cwd: target }),
      this.run(['symbolic-ref', '--short', 'HEAD'], { cwd: target }).catch(() => ({ stdout: '' }))
    ]);
    return {
      defaultBranch: head.stdout.trim().replace(/^refs\/heads\//, '') || project.defaultBranch || 'main',
      commitCount: Number.parseInt(count.stdout, 10) || 0,
      refs: refs.stdout.trim() ? refs.stdout.trim().split('\n').map(line => {
        const [name, hash, updatedAt] = line.split('\t');
        return { name, hash, updatedAt };
      }) : []
    };
  }

  async merge(project, { sourceBranch, targetBranch, title, actor }) {
    for (const branch of [sourceBranch, targetBranch]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) throw new Error('Merge branch is invalid');
    }
    const target = this.pathFor(project);
    const sourceRef = `refs/heads/${sourceBranch}`;
    const targetRef = `refs/heads/${targetBranch}`;
    const [source, destination] = await Promise.all([
      this.run(['rev-parse', '--verify', sourceRef], { cwd: target }),
      this.run(['rev-parse', '--verify', targetRef], { cwd: target })
    ]);
    const sourceHash = source.stdout.trim();
    const targetHash = destination.stdout.trim();
    const already = await this.run(['merge-base', '--is-ancestor', sourceHash, targetHash], { cwd: target }).then(() => true, () => false);
    if (already) return { hash: targetHash, merged: false, reason: 'already-merged' };
    const fastForward = await this.run(['merge-base', '--is-ancestor', targetHash, sourceHash], { cwd: target }).then(() => true, () => false);
    if (fastForward) {
      await this.run(['update-ref', targetRef, sourceHash, targetHash], { cwd: target });
      return { hash: sourceHash, merged: true, fastForward: true };
    }
    const tree = (await this.run(['merge-tree', '--write-tree', targetHash, sourceHash], { cwd: target })).stdout.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error('Merge produced an invalid tree');
    const message = String(title || `Merge ${sourceBranch} into ${targetBranch}`).replace(/[\0\r]/g, '').slice(0, 500);
    const identity = String(actor || 'KitsuneGIT').replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 128) || 'KitsuneGIT';
    const commit = await this.run(['commit-tree', tree, '-p', targetHash, '-p', sourceHash, '-m', message], {
      cwd: target,
      env: { GIT_AUTHOR_NAME: identity, GIT_AUTHOR_EMAIL: 'merge@kitsune.invalid', GIT_COMMITTER_NAME: identity, GIT_COMMITTER_EMAIL: 'merge@kitsune.invalid' }
    });
    const hash = commit.stdout.trim();
    await this.run(['update-ref', targetRef, hash, targetHash], { cwd: target });
    return { hash, merged: true, fastForward: false };
  }

  remove(project) {
    const target = this.pathFor(project);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}

module.exports = { GitRepositoryService };
