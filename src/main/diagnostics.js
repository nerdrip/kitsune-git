const fs = require('node:fs');
const path = require('node:path');
const { runProcess } = require('./process-runner');
const { normalizeRepositoryPath } = require('../git/validation');

function check(id, label, status, detail, fixable = false) {
  return { id, label, status, detail: String(detail || ''), fixable };
}

function sanitizeRemoteUrl(value) {
  const text = String(value || '').trim();
  try {
    const url = new URL(text);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.href;
  } catch {
    return text.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@').slice(0, 2048);
  }
}

class DiagnosticsService {
  constructor({ runtimeManager, credentialManager, appVersion, isPackaged }) {
    this.runtimeManager = runtimeManager;
    this.credentialManager = credentialManager;
    this.appVersion = appVersion;
    this.isPackaged = isPackaged;
  }

  async _git(runtime, args, options = {}) {
    return await runProcess(runtime.binary, args, {
      cwd: options.cwd,
      env: runtime.environment,
      timeoutMs: options.timeoutMs || 15_000,
      rejectOnError: options.rejectOnError,
      maxOutput: 512 * 1024
    });
  }

  async run(repoPath) {
    const checks = [];
    const runtimeStatus = await this.runtimeManager.getStatus(repoPath);
    checks.push(check(
      'git-runtime',
      'Git runtime',
      runtimeStatus.selected ? 'pass' : 'fail',
      runtimeStatus.selected
        ? `${runtimeStatus.selected.source} Git ${runtimeStatus.selected.version} (${runtimeStatus.selected.binary})`
        : runtimeStatus.error,
      Boolean(runtimeStatus.managedInstallAvailable)
    ));

    let runtime = null;
    try { runtime = await this.runtimeManager.resolve(repoPath); } catch { /* represented above */ }
    if (runtime) {
      const buildOptions = await this._git(runtime, ['version', '--build-options'], { rejectOnError: false });
      checks.push(check('git-build', 'Git executable test', buildOptions.code === 0 ? 'pass' : 'fail', (buildOptions.stdout || buildOptions.stderr).trim()));

      const name = await this._git(runtime, ['config', '--global', '--get', 'user.name'], { rejectOnError: false });
      const email = await this._git(runtime, ['config', '--global', '--get', 'user.email'], { rejectOnError: false });
      checks.push(check('git-identity', 'Commit identity', name.stdout.trim() && email.stdout.trim() ? 'pass' : 'warn',
        name.stdout.trim() && email.stdout.trim() ? `${name.stdout.trim()} <${email.stdout.trim()}>` : 'Global user.name or user.email is missing'));

      if (process.platform === 'win32') {
        const longPaths = await this._git(runtime, ['config', '--global', '--get', 'core.longpaths'], { rejectOnError: false });
        const enabled = longPaths.stdout.trim().toLowerCase() === 'true';
        checks.push(check('git-longpaths', 'Windows long paths', enabled ? 'pass' : 'warn', enabled ? 'core.longpaths=true' : 'Long repository paths may fail', true));
      }
    }

    try {
      const auth = await this.credentialManager.getStatus(repoPath);
      checks.push(check('gcm', 'HTTPS credential manager', auth.gcm.available ? 'pass' : 'warn',
        auth.gcm.available ? `GCM ${auth.gcm.version}; store: ${auth.gcm.store || 'platform default'}` : 'GCM is not available in the selected runtime'));
      checks.push(check('openssh', 'OpenSSH tools', auth.ssh.executable && auth.ssh.keygen && auth.ssh.add ? 'pass' : 'warn',
        auth.ssh.executable ? auth.ssh.executable : 'ssh executable was not found'));
      checks.push(check('ssh-agent', 'SSH agent', auth.ssh.agent.available ? 'pass' : 'warn',
        auth.ssh.agent.available ? `${auth.ssh.agent.keys.length} identities loaded` : auth.ssh.agent.error));
      const sshDirectoryExists = fs.statSync(auth.ssh.directory, { throwIfNoEntry: false })?.isDirectory();
      checks.push(check('ssh-directory', 'SSH configuration directory', sshDirectoryExists ? 'pass' : 'warn',
        sshDirectoryExists ? auth.ssh.directory : `${auth.ssh.directory} does not exist`, !sshDirectoryExists));
    } catch (error) {
      checks.push(check('authentication', 'Authentication environment', 'fail', error.message));
    }

    let repository = null;
    if (repoPath) {
      const normalized = normalizeRepositoryPath(repoPath);
      repository = { path: normalized, remotes: [] };
      try {
        fs.accessSync(normalized, fs.constants.R_OK | fs.constants.W_OK);
        checks.push(check('repo-access', 'Repository access', 'pass', 'Directory is readable and writable'));
      } catch (error) {
        checks.push(check('repo-access', 'Repository access', 'fail', error.message));
      }
      if (runtime) {
        const inside = await this._git(runtime, ['rev-parse', '--is-inside-work-tree'], { cwd: normalized, rejectOnError: false });
        checks.push(check('repo-valid', 'Repository structure', inside.stdout.trim() === 'true' ? 'pass' : 'fail',
          inside.stdout.trim() === 'true' ? 'Valid Git working tree' : inside.stderr.trim()));
        const remotes = await this._git(runtime, ['remote', '-v'], { cwd: normalized, rejectOnError: false });
        repository.remotes = remotes.stdout.split(/\r?\n/).map(line => {
          const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line.trim());
          return match ? { name: match[1], url: sanitizeRemoteUrl(match[2]), direction: match[3] } : null;
        }).filter(Boolean).slice(0, 100);
        checks.push(check('repo-remotes', 'Repository remotes', repository.remotes.length ? 'pass' : 'warn',
          repository.remotes.length ? `${repository.remotes.length} remote endpoint(s)` : 'No remotes configured'));
      }
      try {
        const disk = fs.statfsSync(normalized);
        const freeBytes = Number(disk.bavail) * Number(disk.bsize);
        const freeGiB = freeBytes / 1024 / 1024 / 1024;
        checks.push(check('disk-space', 'Free disk space', freeGiB >= 2 ? 'pass' : 'warn', `${freeGiB.toFixed(1)} GiB available`));
      } catch { /* statfs is not available on every filesystem */ }
    }

    const summary = {
      pass: checks.filter(item => item.status === 'pass').length,
      warn: checks.filter(item => item.status === 'warn').length,
      fail: checks.filter(item => item.status === 'fail').length
    };
    return {
      generatedAt: new Date().toISOString(),
      application: { version: this.appVersion, packaged: this.isPackaged },
      system: { platform: process.platform, arch: process.arch, release: require('node:os').release() },
      repository,
      checks,
      summary
    };
  }

  async fix(id, repoPath) {
    if (id === 'ssh-directory') {
      fs.mkdirSync(this.credentialManager.sshDirectory, { recursive: true, mode: 0o700 });
      return await this.run(repoPath);
    }
    if (id === 'git-longpaths' && process.platform === 'win32') {
      const runtime = await this.runtimeManager.resolve(repoPath);
      await this._git(runtime, ['config', '--global', 'core.longpaths', 'true']);
      return await this.run(repoPath);
    }
    if (id === 'git-runtime') {
      await this.runtimeManager.installManaged();
      return await this.run(repoPath);
    }
    throw new Error('This diagnostic check has no automatic fix');
  }
}

module.exports = { DiagnosticsService, sanitizeRemoteUrl };
