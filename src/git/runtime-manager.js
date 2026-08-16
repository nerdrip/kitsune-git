const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { extractZip } = require('../main/safe-zip');
const { runProcess } = require('../main/process-runner');
const { normalizeRepositoryPath, sanitizeGitEnvironment } = require('./validation');
const manifest = require('./runtime-manifest.json');

const MODES = new Set(['auto', 'system', 'managed', 'custom']);
const MINIMUM_GIT_VERSION = '2.30.0';
const SETTINGS_VERSION = 1;

function normalizeExecutablePath(value, { mustExist = true } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32_767 || /[\0\r\n]/.test(value)) {
    throw new Error('Git executable path is invalid');
  }
  const resolved = path.resolve(value.trim());
  if (mustExist) {
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Git executable does not exist: ${resolved}`);
  }
  return resolved;
}

function parseGitVersion(output) {
  const match = /git version\s+(\d+\.\d+\.\d+(?:\.\d+)?)/i.exec(String(output));
  return match ? match[1] : null;
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(value => Number.parseInt(value, 10) || 0);
  const b = String(right).split('.').map(value => Number.parseInt(value, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'win32') fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
}

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    mode: 'auto',
    customPath: '',
    managedVersion: '',
    repositoryOverrides: {}
  };
}

class GitRuntimeManager {
  constructor({ userDataPath, resourcesPath, platform = process.platform, arch = process.arch, developmentRoot }) {
    this.userDataPath = path.resolve(userDataPath);
    this.resourcesPath = resourcesPath ? path.resolve(resourcesPath) : null;
    this.platform = platform;
    this.arch = arch;
    this.developmentRoot = developmentRoot ? path.resolve(developmentRoot) : null;
    this.settingsFile = path.join(this.userDataPath, 'git-runtime.json');
    this.runtimeRoot = path.join(this.userDataPath, 'runtimes', 'git');
    this._settings = this._readSettings();
    this._cache = new Map();
    this._installPromise = null;
  }

  _readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      const settings = defaultSettings();
      if (MODES.has(parsed.mode)) settings.mode = parsed.mode;
      if (typeof parsed.customPath === 'string' && parsed.customPath.length <= 32_767) settings.customPath = parsed.customPath;
      if (typeof parsed.managedVersion === 'string' && /^[0-9.]{0,32}$/.test(parsed.managedVersion)) {
        settings.managedVersion = parsed.managedVersion;
      }
      if (parsed.repositoryOverrides && typeof parsed.repositoryOverrides === 'object') {
        for (const [repoPath, override] of Object.entries(parsed.repositoryOverrides).slice(0, 200)) {
          if (!override || !MODES.has(override.mode)) continue;
          const normalized = path.resolve(repoPath);
          settings.repositoryOverrides[normalized] = {
            mode: override.mode,
            customPath: typeof override.customPath === 'string' ? override.customPath.slice(0, 32_767) : ''
          };
        }
      }
      return settings;
    } catch {
      return defaultSettings();
    }
  }

  _saveSettings() {
    atomicWriteJson(this.settingsFile, this._settings);
    this._cache.clear();
  }

  getSettings(repoPath) {
    const normalizedRepo = repoPath ? normalizeRepositoryPath(repoPath) : null;
    return {
      mode: this._settings.mode,
      customPath: this._settings.customPath,
      managedVersion: this._settings.managedVersion,
      repositoryOverride: normalizedRepo ? (this._settings.repositoryOverrides[normalizedRepo] || null) : null,
      minimumVersion: MINIMUM_GIT_VERSION,
      bundledVersion: manifest.gitVersion
    };
  }

  async setSettings(input, repoPath) {
    if (!input || !MODES.has(input.mode)) throw new Error('Unsupported Git runtime mode');
    const customPath = input.mode === 'custom'
      ? normalizeExecutablePath(input.customPath)
      : (typeof input.customPath === 'string' ? input.customPath.slice(0, 32_767) : '');

    if (input.mode === 'custom') await this._inspectExecutable(customPath, 'custom');

    if (input.scope === 'repository') {
      const normalizedRepo = normalizeRepositoryPath(repoPath);
      this._settings.repositoryOverrides[normalizedRepo] = { mode: input.mode, customPath };
    } else {
      this._settings.mode = input.mode;
      this._settings.customPath = customPath;
    }
    this._saveSettings();
    return await this.getStatus(repoPath);
  }

  clearRepositoryOverride(repoPath) {
    const normalizedRepo = normalizeRepositoryPath(repoPath);
    delete this._settings.repositoryOverrides[normalizedRepo];
    this._saveSettings();
    return this.getSettings(repoPath);
  }

  _selection(repoPath) {
    if (repoPath) {
      const normalizedRepo = path.resolve(repoPath);
      const override = this._settings.repositoryOverrides[normalizedRepo];
      if (override) return { ...override, scope: 'repository' };
    }
    return { mode: this._settings.mode, customPath: this._settings.customPath, scope: 'global' };
  }

  _managedCandidates() {
    const executable = this.platform === 'win32' ? path.join('cmd', 'git.exe') : path.join('bin', 'git');
    const candidates = [];
    if (this._settings.managedVersion) {
      candidates.push(path.join(this.runtimeRoot, this._settings.managedVersion, executable));
    }
    candidates.push(path.join(this.runtimeRoot, manifest.gitVersion, executable));
    if (this.resourcesPath) candidates.push(path.join(this.resourcesPath, 'git-runtime', executable));
    if (this.developmentRoot) {
      const platformName = this.platform === 'darwin' ? 'mac' : this.platform === 'win32' ? 'win' : 'linux';
      candidates.push(path.join(this.developmentRoot, 'build', 'runtime', `${platformName}-${this.arch}`, executable));
    }
    return [...new Set(candidates)];
  }

  async _systemCandidates() {
    const candidates = [];
    try {
      const locator = this.platform === 'win32' ? 'where.exe' : 'which';
      const args = this.platform === 'win32' ? ['git.exe'] : ['-a', 'git'];
      const result = await runProcess(locator, args, { timeoutMs: 5_000, rejectOnError: false, maxOutput: 128 * 1024 });
      for (const line of result.stdout.split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate) candidates.push(candidate);
      }
    } catch { /* fall through to conventional locations */ }

    if (this.platform === 'win32') {
      for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
        if (base) candidates.push(path.join(base, 'Git', 'cmd', 'git.exe'));
      }
    } else {
      candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git');
    }
    return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
  }

  _environmentFor(binary) {
    const env = sanitizeGitEnvironment(process.env);
    const binaryDir = path.dirname(binary);
    const prefix = this.platform === 'win32' && path.basename(binaryDir).toLowerCase() === 'cmd'
      ? path.dirname(binaryDir)
      : path.dirname(binaryDir);
    const pathParts = [binaryDir];
    if (this.platform === 'win32') {
      pathParts.push(
        path.join(prefix, 'mingw64', 'bin'),
        path.join(prefix, 'clangarm64', 'bin'),
        path.join(prefix, 'usr', 'bin')
      );
    } else {
      const execPath = path.join(prefix, 'libexec', 'git-core');
      const templatePath = path.join(prefix, 'share', 'git-core', 'templates');
      if (fs.existsSync(execPath)) env.GIT_EXEC_PATH = execPath;
      if (fs.existsSync(templatePath)) env.GIT_TEMPLATE_DIR = templatePath;
    }
    pathParts.push(path.join(prefix, 'gcm'));
    env.PATH = [...pathParts.filter(item => fs.existsSync(item)), process.env.PATH || ''].join(path.delimiter);
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
  }

  async _inspectExecutable(candidate, source) {
    const binary = normalizeExecutablePath(candidate);
    const cacheKey = `${source}:${binary}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < 10_000) return cached;
    const result = await runProcess(binary, ['--version'], {
      env: this._environmentFor(binary),
      timeoutMs: 10_000,
      maxOutput: 128 * 1024
    });
    const version = parseGitVersion(result.stdout || result.stderr);
    if (!version) throw new Error(`Unable to determine Git version for ${binary}`);
    const info = {
      source,
      binary,
      version,
      supported: compareVersions(version, MINIMUM_GIT_VERSION) >= 0,
      environment: this._environmentFor(binary),
      checkedAt: Date.now()
    };
    this._cache.set(cacheKey, info);
    return info;
  }

  async _firstWorking(candidates, source) {
    for (const candidate of candidates) {
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
      try {
        const info = await this._inspectExecutable(candidate, source);
        if (info.supported) return info;
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  async resolve(repoPath) {
    const selection = this._selection(repoPath);
    let info = null;
    if (selection.mode === 'custom') info = await this._inspectExecutable(selection.customPath, 'custom');
    if (selection.mode === 'managed') info = await this._firstWorking(this._managedCandidates(), 'managed');
    if (selection.mode === 'system') info = await this._firstWorking(await this._systemCandidates(), 'system');
    if (selection.mode === 'auto') {
      info = await this._firstWorking(await this._systemCandidates(), 'system');
      if (!info) info = await this._firstWorking(this._managedCandidates(), 'managed');
    }
    if (!info) {
      throw new Error(selection.mode === 'managed'
        ? 'Managed Git runtime is not installed. Open Settings → Git Runtime and install it.'
        : `No supported Git ${MINIMUM_GIT_VERSION}+ runtime was found.`);
    }
    if (!info.supported) throw new Error(`Git ${info.version} is too old. KitsuneGIT requires ${MINIMUM_GIT_VERSION} or newer.`);
    return { ...info, mode: selection.mode, scope: selection.scope };
  }

  async getStatus(repoPath) {
    const selection = this._selection(repoPath);
    const system = await this._firstWorking(await this._systemCandidates(), 'system');
    const managed = await this._firstWorking(this._managedCandidates(), 'managed');
    let selected = null;
    let error = null;
    try {
      selected = await this.resolve(repoPath);
    } catch (cause) {
      error = cause.message;
    }
    const stripEnvironment = info => info && ({
      source: info.source,
      binary: info.binary,
      version: info.version,
      supported: info.supported
    });
    return {
      selection,
      selected: stripEnvironment(selected),
      system: stripEnvironment(system),
      managed: stripEnvironment(managed),
      managedInstallAvailable: Boolean(manifest.downloads[`${this.platform}-${this.arch}`]),
      minimumVersion: MINIMUM_GIT_VERSION,
      bundledVersion: manifest.gitVersion,
      platform: this.platform,
      arch: this.arch,
      error
    };
  }

  async installManaged(onProgress = () => {}) {
    if (this._installPromise) return await this._installPromise;
    const download = manifest.downloads[`${this.platform}-${this.arch}`];
    if (!download) {
      throw new Error('This platform receives managed Git inside its native application package; no standalone runtime download is configured.');
    }
    this._installPromise = this._installWindowsRuntime(download, onProgress);
    try {
      return await this._installPromise;
    } finally {
      this._installPromise = null;
    }
  }

  async _installWindowsRuntime(download, onProgress) {
    fs.mkdirSync(this.runtimeRoot, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(this.runtimeRoot, '.install-'));
    const archivePath = path.join(temporaryRoot, 'runtime.zip');
    const extractPath = path.join(temporaryRoot, 'extracted');
    try {
      onProgress({ stage: 'download', percent: 0, message: `Downloading Git ${manifest.gitVersion}...` });
      await this._download(download.url, archivePath, download.sha256, onProgress);
      onProgress({ stage: 'extract', percent: 0, message: 'Extracting managed Git...' });
      await extractZip(archivePath, { dir: extractPath });
      await this._installWindowsAddons(extractPath, temporaryRoot, onProgress);
      const candidate = path.join(extractPath, 'cmd', 'git.exe');
      await this._inspectExecutable(candidate, 'managed');

      const destination = path.join(this.runtimeRoot, manifest.gitVersion);
      const previous = `${destination}.previous`;
      fs.rmSync(previous, { recursive: true, force: true });
      if (fs.existsSync(destination)) fs.renameSync(destination, previous);
      fs.renameSync(extractPath, destination);
      fs.rmSync(previous, { recursive: true, force: true });
      this._settings.managedVersion = manifest.gitVersion;
      this._saveSettings();
      onProgress({ stage: 'complete', percent: 100, message: `Git ${manifest.gitVersion} installed.` });
      return await this.getStatus();
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  async _installWindowsAddons(extractPath, temporaryRoot, onProgress) {
    const addons = manifest.addons?.[`win32-${this.arch}`];
    if (!addons) throw new Error(`Managed Git add-ons are not available for win32-${this.arch}`);
    for (const [name, descriptor] of Object.entries(addons)) {
      if (name === 'gcm' && this._findFile(extractPath, 'git-credential-manager.exe')) continue;
      const archive = path.join(temporaryRoot, `${name}.zip`);
      const extracted = path.join(temporaryRoot, `${name}-extracted`);
      onProgress({ stage: 'download', percent: 0, message: `Downloading ${name === 'gcm' ? 'Git Credential Manager' : 'Git LFS'}...` });
      await this._download(descriptor.url, archive, descriptor.sha256, onProgress);
      await extractZip(archive, { dir: extracted });
      const executable = this._findFile(extracted, name === 'gcm' ? 'git-credential-manager.exe' : 'git-lfs.exe');
      if (!executable) throw new Error(`${name.toUpperCase()} executable was not found in its verified archive`);
      if (name === 'gcm') {
        fs.cpSync(path.dirname(executable), path.join(extractPath, 'gcm'), { recursive: true, force: true });
      } else {
        fs.copyFileSync(executable, path.join(extractPath, 'cmd', 'git-lfs.exe'));
      }
    }
  }

  _findFile(directory, fileName) {
    const queue = [directory];
    while (queue.length) {
      const current = queue.shift();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(target);
        else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return target;
      }
    }
    return null;
  }

  _download(url, destination, expectedHash, onProgress, redirects = 0) {
    if (redirects > 5) return Promise.reject(new Error('Too many redirects while downloading Git runtime'));
    return new Promise((resolve, reject) => {
      const request = https.get(url, { headers: { 'User-Agent': 'KitsuneGIT-runtime-manager' } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          return this._download(new URL(response.headers.location, url).href, destination, expectedHash, onProgress, redirects + 1)
            .then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`Git runtime download failed with HTTP ${response.statusCode}`));
        }
        const total = Number.parseInt(response.headers['content-length'] || '0', 10);
        let received = 0;
        const hash = crypto.createHash('sha256');
        const output = fs.createWriteStream(destination, { mode: 0o600 });
        response.on('data', chunk => {
          received += chunk.length;
          hash.update(chunk);
          if (total > 0) {
            onProgress({ stage: 'download', percent: Math.min(99, Math.round(received / total * 100)), message: 'Downloading managed Git...' });
          }
        });
        response.once('error', reject);
        output.once('error', reject);
        output.once('finish', () => {
          const actualHash = hash.digest('hex');
          if (actualHash !== expectedHash.toLowerCase()) {
            return reject(new Error('Downloaded Git runtime failed SHA-256 verification'));
          }
          resolve();
        });
        response.pipe(output);
      });
      request.once('error', reject);
      request.setTimeout(60_000, () => request.destroy(new Error('Git runtime download timed out')));
    });
  }
}

module.exports = {
  GitRuntimeManager,
  MINIMUM_GIT_VERSION,
  compareVersions,
  normalizeExecutablePath,
  parseGitVersion
};
