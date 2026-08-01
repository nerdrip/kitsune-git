const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('../main/process-runner');
const { normalizeRepositoryPath } = require('../git/validation');

const SETTINGS_VERSION = 1;
const ALLOWED_STORES = {
  win32: new Set(['wincredman', 'dpapi', 'none']),
  darwin: new Set(['keychain', 'cache', 'gpg', 'none']),
  linux: new Set(['secretservice', 'gpg', 'cache', 'none'])
};

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'win32') fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
}

function assertKeyPath(keyPath) {
  if (typeof keyPath !== 'string' || !keyPath || keyPath.length > 32_767 || /[\0\r\n"]/.test(keyPath)) {
    throw new Error('SSH key path is invalid');
  }
  const resolved = path.resolve(keyPath);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`SSH private key does not exist: ${resolved}`);
  }
  return resolved;
}

function assertKeyName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('Key name may contain only letters, numbers, dots, underscores, and hyphens');
  }
  return name;
}

function assertKeyComment(comment) {
  const value = String(comment || '').trim();
  if (!value || value.length > 254 || !/^[A-Za-z0-9@._+ -]+$/.test(value)) {
    throw new Error('Key comment contains unsupported characters');
  }
  return value;
}

function assertSshHost(host) {
  if (typeof host !== 'string' || host.length > 253 || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/.test(host)) {
    throw new Error('SSH host name is invalid');
  }
  return host.toLowerCase();
}

function assertPort(port) {
  const value = Number(port || 22);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('SSH port is invalid');
  return value;
}

function parseFingerprint(line) {
  const match = /^\s*(\d+)\s+(SHA256:[^\s]+)\s+(.+?)\s+\(([^)]+)\)\s*$/.exec(String(line));
  return match ? { bits: Number(match[1]), fingerprint: match[2], comment: match[3], algorithm: match[4] } : null;
}

class CredentialManager {
  constructor({ runtimeManager, userDataPath, platform = process.platform, homeDirectory = os.homedir() }) {
    this.runtimeManager = runtimeManager;
    this.userDataPath = path.resolve(userDataPath);
    this.platform = platform;
    this.homeDirectory = path.resolve(homeDirectory);
    this.sshDirectory = path.join(this.homeDirectory, '.ssh');
    this.settingsFile = path.join(this.userDataPath, 'authentication.json');
    this.generatedConfigDirectory = path.join(this.userDataPath, 'ssh');
    this._settings = this._readSettings();
  }

  _readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      const repositoryKeys = {};
      if (parsed.repositoryKeys && typeof parsed.repositoryKeys === 'object') {
        for (const [repoPath, keyPath] of Object.entries(parsed.repositoryKeys).slice(0, 200)) {
          if (typeof keyPath === 'string' && keyPath.length <= 32_767) repositoryKeys[path.resolve(repoPath)] = keyPath;
        }
      }
      const externalKeys = Array.isArray(parsed.externalKeys)
        ? parsed.externalKeys.filter(value => typeof value === 'string' && value.length <= 32_767).slice(0, 100)
        : [];
      return { version: SETTINGS_VERSION, repositoryKeys, externalKeys };
    } catch {
      return { version: SETTINGS_VERSION, repositoryKeys: {}, externalKeys: [] };
    }
  }

  _saveSettings() {
    atomicWriteJson(this.settingsFile, this._settings);
  }

  async _findTool(name, runtime) {
    const executableName = this.platform === 'win32' ? `${name}.exe` : name;
    const directCandidates = [];
    for (const directory of String(runtime.environment.PATH || '').split(path.delimiter)) {
      if (directory) directCandidates.push(path.join(directory, executableName));
    }
    for (const candidate of directCandidates) {
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return path.resolve(candidate);
    }
    try {
      const locator = this.platform === 'win32' ? 'where.exe' : 'which';
      const result = await runProcess(locator, [executableName], {
        env: runtime.environment,
        timeoutMs: 5_000,
        rejectOnError: false,
        maxOutput: 64 * 1024
      });
      const first = result.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean);
      return first ? path.resolve(first) : null;
    } catch {
      return null;
    }
  }

  async _git(runtime, args, options = {}) {
    return await runProcess(runtime.binary, args, {
      env: runtime.environment,
      timeoutMs: options.timeoutMs || 20_000,
      rejectOnError: options.rejectOnError,
      maxOutput: options.maxOutput || 512 * 1024,
      input: options.input
    });
  }

  async getStatus(repoPath) {
    const runtime = await this.runtimeManager.resolve(repoPath);
    const [ssh, sshKeygen, sshAdd] = await Promise.all([
      this._findTool('ssh', runtime),
      this._findTool('ssh-keygen', runtime),
      this._findTool('ssh-add', runtime)
    ]);
    const gcmResult = await this._git(runtime, ['credential-manager', '--version'], { rejectOnError: false });
    const helperResult = await this._git(runtime, ['config', '--global', '--get-all', 'credential.helper'], { rejectOnError: false });
    const storeResult = await this._git(runtime, ['config', '--global', '--get', 'credential.credentialStore'], { rejectOnError: false });
    const keys = sshKeygen ? await this.listKeys(sshKeygen) : [];
    const agent = sshAdd ? await this.listAgentKeys(sshAdd, runtime.environment) : { available: false, keys: [], error: 'ssh-add was not found' };
    const normalizedRepo = repoPath ? normalizeRepositoryPath(repoPath) : null;
    const selectedKey = normalizedRepo ? this._settings.repositoryKeys[normalizedRepo] || null : null;
    return {
      gcm: {
        available: gcmResult.code === 0,
        version: gcmResult.code === 0 ? gcmResult.stdout.trim() : null,
        helpers: helperResult.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        store: storeResult.stdout.trim() || null,
        allowedStores: [...(ALLOWED_STORES[this.platform] || ALLOWED_STORES.linux)]
      },
      ssh: { executable: ssh, keygen: sshKeygen, add: sshAdd, directory: this.sshDirectory, keys, agent, selectedKey }
    };
  }

  async listKeys(sshKeygen) {
    const candidates = new Set(this._settings.externalKeys);
    try {
      for (const entry of fs.readdirSync(this.sshDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.pub')) continue;
        const privatePath = path.join(this.sshDirectory, entry.name.slice(0, -4));
        if (fs.statSync(privatePath, { throwIfNoEntry: false })?.isFile()) candidates.add(privatePath);
      }
    } catch { /* no ~/.ssh yet */ }

    const keys = [];
    for (const candidate of [...candidates].slice(0, 200)) {
      const privatePath = path.resolve(candidate);
      const publicPath = `${privatePath}.pub`;
      if (!fs.statSync(privatePath, { throwIfNoEntry: false })?.isFile()) continue;
      let details = null;
      if (fs.statSync(publicPath, { throwIfNoEntry: false })?.isFile()) {
        const result = await runProcess(sshKeygen, ['-lf', publicPath], { timeoutMs: 5_000, rejectOnError: false, maxOutput: 64 * 1024 });
        details = parseFingerprint(result.stdout);
      }
      keys.push({
        path: privatePath,
        publicPath: fs.existsSync(publicPath) ? publicPath : null,
        name: path.basename(privatePath),
        managedLocation: path.relative(this.sshDirectory, privatePath) === path.basename(privatePath),
        ...(details || { bits: null, fingerprint: null, comment: null, algorithm: 'unknown' })
      });
    }
    return keys.sort((left, right) => left.name.localeCompare(right.name));
  }

  async listAgentKeys(sshAdd, environment) {
    const result = await runProcess(sshAdd, ['-l'], {
      env: environment,
      timeoutMs: 5_000,
      rejectOnError: false,
      maxOutput: 256 * 1024
    });
    if (result.code === 2) return { available: false, keys: [], error: result.stderr.trim() || 'SSH agent is not running' };
    const keys = result.stdout.split(/\r?\n/).map(parseFingerprint).filter(Boolean);
    return { available: true, keys, error: null };
  }

  async configureGcm(repoPath, store) {
    const allowed = ALLOWED_STORES[this.platform] || ALLOWED_STORES.linux;
    if (!allowed.has(store)) throw new Error('Unsupported credential store for this platform');
    const runtime = await this.runtimeManager.resolve(repoPath);
    const version = await this._git(runtime, ['credential-manager', '--version'], { rejectOnError: false });
    if (version.code !== 0) throw new Error('Git Credential Manager is not available in the selected Git runtime');
    await this._git(runtime, ['credential-manager', 'configure']);
    await this._git(runtime, ['config', '--global', 'credential.credentialStore', store]);
    return await this.getStatus(repoPath);
  }

  async importKey(keyPath) {
    const normalized = assertKeyPath(keyPath);
    if (!this._settings.externalKeys.includes(normalized)) this._settings.externalKeys.push(normalized);
    this._settings.externalKeys = this._settings.externalKeys.slice(-100);
    this._saveSettings();
    return normalized;
  }

  removeImportedKey(keyPath) {
    const normalized = path.resolve(keyPath);
    this._settings.externalKeys = this._settings.externalKeys.filter(value => path.resolve(value) !== normalized);
    for (const [repoPath, selected] of Object.entries(this._settings.repositoryKeys)) {
      if (path.resolve(selected) === normalized) delete this._settings.repositoryKeys[repoPath];
    }
    this._saveSettings();
  }

  setRepositoryKey(repoPath, keyPath) {
    const normalizedRepo = normalizeRepositoryPath(repoPath);
    if (!keyPath) delete this._settings.repositoryKeys[normalizedRepo];
    else this._settings.repositoryKeys[normalizedRepo] = assertKeyPath(keyPath);
    this._saveSettings();
  }

  async getEnvironment(repoPath, runtime) {
    const normalizedRepo = repoPath ? path.resolve(repoPath) : null;
    const selected = normalizedRepo ? this._settings.repositoryKeys[normalizedRepo] : null;
    if (!selected) return runtime.environment;
    const keyPath = assertKeyPath(selected);
    const ssh = await this._findTool('ssh', runtime);
    if (!ssh) throw new Error('OpenSSH client was not found for the selected Git runtime');
    if (/["\r\n]/.test(ssh) || /["\r\n]/.test(this.generatedConfigDirectory)) {
      throw new Error('SSH executable or application data path cannot be represented safely');
    }
    fs.mkdirSync(this.generatedConfigDirectory, { recursive: true });
    const configName = crypto.createHash('sha256').update(normalizedRepo).digest('hex').slice(0, 24);
    const configPath = path.join(this.generatedConfigDirectory, `${configName}.conf`);
    const config = [
      'Host *',
      `  IdentityFile "${keyPath.replace(/\\/g, '/')}"`,
      '  IdentitiesOnly yes',
      '  AddKeysToAgent yes',
      ''
    ].join('\n');
    fs.writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o600 });
    return {
      ...runtime.environment,
      GIT_SSH_COMMAND: `"${ssh}" -F "${configPath}"`,
      GIT_SSH_VARIANT: 'ssh'
    };
  }

  async prepareGenerateKey(repoPath, input) {
    const runtime = await this.runtimeManager.resolve(repoPath);
    const sshKeygen = await this._findTool('ssh-keygen', runtime);
    if (!sshKeygen) throw new Error('ssh-keygen was not found');
    const name = assertKeyName(input?.name || 'id_ed25519');
    const comment = assertKeyComment(input?.comment);
    fs.mkdirSync(this.sshDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.sshDirectory, name);
    if (fs.existsSync(destination) || fs.existsSync(`${destination}.pub`)) throw new Error('A key with this name already exists');
    return { command: sshKeygen, args: ['-t', 'ed25519', '-a', '64', '-f', destination, '-C', comment], cwd: this.sshDirectory };
  }

  async prepareAddToAgent(repoPath, keyPath) {
    const runtime = await this.runtimeManager.resolve(repoPath);
    const sshAdd = await this._findTool('ssh-add', runtime);
    if (!sshAdd) throw new Error('ssh-add was not found');
    return { command: sshAdd, args: [assertKeyPath(keyPath)], cwd: this.sshDirectory };
  }

  async removeFromAgent(repoPath, keyPath) {
    const runtime = await this.runtimeManager.resolve(repoPath);
    const sshAdd = await this._findTool('ssh-add', runtime);
    if (!sshAdd) throw new Error('ssh-add was not found');
    await runProcess(sshAdd, ['-d', assertKeyPath(keyPath)], { env: runtime.environment, timeoutMs: 10_000 });
    return true;
  }

  readPublicKey(keyPath) {
    const publicPath = `${assertKeyPath(keyPath)}.pub`;
    const content = fs.readFileSync(publicPath, 'utf8').trim();
    if (!/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp\d+|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.test(content) || content.length > 32_768) {
      throw new Error('Public key file is invalid');
    }
    return content;
  }

  deleteKey(keyPath) {
    const normalized = assertKeyPath(keyPath);
    const relative = path.relative(this.sshDirectory, normalized);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.includes(path.sep)) {
      throw new Error('Only keys stored directly in ~/.ssh can be deleted; external keys can only be unlinked');
    }
    fs.rmSync(normalized, { force: true });
    fs.rmSync(`${normalized}.pub`, { force: true });
    this.removeImportedKey(normalized);
    return true;
  }

  async scanHost(repoPath, host, port = 22) {
    const safeHost = assertSshHost(host);
    const safePort = assertPort(port);
    const runtime = await this.runtimeManager.resolve(repoPath);
    const [sshKeyscan, sshKeygen] = await Promise.all([
      this._findTool('ssh-keyscan', runtime),
      this._findTool('ssh-keygen', runtime)
    ]);
    if (!sshKeyscan || !sshKeygen) throw new Error('ssh-keyscan and ssh-keygen are required');
    const scan = await runProcess(sshKeyscan, ['-T', '5', '-p', String(safePort), safeHost], {
      env: runtime.environment,
      timeoutMs: 10_000,
      maxOutput: 256 * 1024
    });
    const lines = scan.stdout.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
    const keys = [];
    for (const line of lines.slice(0, 20)) {
      const fingerprint = await runProcess(sshKeygen, ['-lf', '-'], {
        env: runtime.environment,
        input: `${line}\n`,
        timeoutMs: 5_000,
        rejectOnError: false,
        maxOutput: 64 * 1024
      });
      keys.push({ line, ...(parseFingerprint(fingerprint.stdout) || {}) });
    }
    return { host: safeHost, port: safePort, keys };
  }

  trustHost(scanResult) {
    if (!scanResult || !Array.isArray(scanResult.keys) || scanResult.keys.length === 0) throw new Error('No scanned host keys to trust');
    const host = assertSshHost(scanResult.host);
    assertPort(scanResult.port);
    fs.mkdirSync(this.sshDirectory, { recursive: true, mode: 0o700 });
    const knownHosts = path.join(this.sshDirectory, 'known_hosts');
    const existing = fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, 'utf8') : '';
    const additions = scanResult.keys.map(item => String(item.line || '').trim()).filter(line => {
      if (!line || /[\0\r\n]/.test(line) || !line.startsWith(host) && !line.startsWith(`[${host}]:`)) {
        throw new Error('Scanned host key is invalid');
      }
      return !existing.split(/\r?\n/).includes(line);
    });
    if (additions.length) fs.appendFileSync(knownHosts, `${existing && !existing.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`, { mode: 0o600 });
    return additions.length;
  }

  async testSsh(repoPath, host, port = 22, user = 'git') {
    const safeHost = assertSshHost(host);
    const safePort = assertPort(port);
    if (typeof user !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new Error('SSH user is invalid');
    const runtime = await this.runtimeManager.resolve(repoPath);
    const ssh = await this._findTool('ssh', runtime);
    if (!ssh) throw new Error('OpenSSH client was not found');
    const environment = await this.getEnvironment(repoPath, runtime);
    const result = await runProcess(ssh, [
      '-T', '-p', String(safePort),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      `${user}@${safeHost}`
    ], {
      env: environment,
      timeoutMs: 20_000,
      rejectOnError: false,
      maxOutput: 256 * 1024
    });
    return {
      success: result.code === 0 || /successfully authenticated|welcome to gitlab/i.test(`${result.stdout}\n${result.stderr}`),
      code: result.code,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 16_384)
    };
  }

  async eraseHttpsCredential(repoPath, host) {
    const safeHost = assertSshHost(host);
    const runtime = await this.runtimeManager.resolve(repoPath);
    await this._git(runtime, ['credential', 'reject'], { input: `protocol=https\nhost=${safeHost}\n\n` });
    return true;
  }
}

module.exports = {
  CredentialManager,
  assertKeyComment,
  assertKeyName,
  assertSshHost,
  parseFingerprint
};
