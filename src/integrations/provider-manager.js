const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { assertRefName, assertSingleLine } = require('../git/validation');

const SETTINGS_VERSION = 1;
const PROVIDERS = {
  github: { name: 'GitHub', defaultBaseUrl: 'https://api.github.com', host: 'github.com' },
  gitlab: { name: 'GitLab', defaultBaseUrl: 'https://gitlab.com/api/v4', host: 'gitlab.com' },
  bitbucket: { name: 'Bitbucket', defaultBaseUrl: 'https://api.bitbucket.org/2.0', host: 'bitbucket.org' }
};

function assertProvider(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('Unsupported repository provider');
  return provider;
}

function normalizeBaseUrl(value, provider) {
  const fallback = PROVIDERS[assertProvider(provider)].defaultBaseUrl;
  let parsed;
  try { parsed = new URL(String(value || fallback)); } catch { throw new Error('Provider API URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Provider API URL must be a clean HTTPS URL');
  }
  return parsed.href.replace(/\/$/, '');
}

function assertToken(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 8192 || /[\0\r\n]/.test(value)) {
    throw new Error('Access token is invalid');
  }
  return value;
}

function parseRemoteUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) return null;
  let host;
  let pathname;
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  if (!value.includes('://') && scp && !/^[A-Za-z]:[\\/]/.test(value)) {
    host = scp[1].toLowerCase();
    pathname = scp[2];
  } else {
    try {
      const parsed = new URL(value);
      if (!['https:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
    } catch { return null; }
  }
  const segments = String(pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length < 2 || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment))) return null;
  return { host, owner: segments.slice(0, -1).join('/'), repo: segments.at(-1) };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'win32') fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
}

class ProviderManager {
  constructor({ userDataPath, safeStorage }) {
    this.safeStorage = safeStorage;
    this.settingsFile = path.join(path.resolve(userDataPath), 'providers.json');
    this._settings = this._readSettings();
  }

  _readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      const accounts = {};
      for (const [provider, account] of Object.entries(parsed.accounts || {})) {
        if (!PROVIDERS[provider] || !account || typeof account.encryptedToken !== 'string') continue;
        accounts[provider] = {
          baseUrl: normalizeBaseUrl(account.baseUrl, provider),
          encryptedToken: account.encryptedToken.slice(0, 64 * 1024),
          username: typeof account.username === 'string' ? account.username.slice(0, 256) : ''
        };
      }
      return { version: SETTINGS_VERSION, accounts };
    } catch {
      return { version: SETTINGS_VERSION, accounts: {} };
    }
  }

  _encryptionStatus() {
    const available = Boolean(this.safeStorage?.isEncryptionAvailable?.());
    const backend = this.safeStorage?.getSelectedStorageBackend?.() || (available ? 'system' : 'unavailable');
    return { available: available && backend !== 'basic_text', backend };
  }

  _requireEncryption() {
    const status = this._encryptionStatus();
    if (!status.available) throw new Error('A secure operating-system credential store is unavailable; token persistence is disabled');
    return status;
  }

  _token(provider) {
    const account = this._settings.accounts[assertProvider(provider)];
    if (!account) throw new Error(`${PROVIDERS[provider].name} account is not configured`);
    this._requireEncryption();
    try {
      return this.safeStorage.decryptString(Buffer.from(account.encryptedToken, 'base64'));
    } catch {
      throw new Error(`Stored ${PROVIDERS[provider].name} token cannot be decrypted on this operating-system account`);
    }
  }

  getStatus() {
    const encryption = this._encryptionStatus();
    return {
      encryption,
      providers: Object.entries(PROVIDERS).map(([id, definition]) => {
        const account = this._settings.accounts[id];
        return {
          id,
          name: definition.name,
          configured: Boolean(account),
          baseUrl: account?.baseUrl || definition.defaultBaseUrl,
          username: account?.username || null
        };
      })
    };
  }

  async saveAccount(input) {
    const provider = assertProvider(input?.provider);
    this._requireEncryption();
    const token = assertToken(input?.token);
    const baseUrl = normalizeBaseUrl(input?.baseUrl, provider);
    const profile = await this._profile(provider, baseUrl, token);
    const encryptedToken = this.safeStorage.encryptString(token).toString('base64');
    this._settings.accounts[provider] = { baseUrl, encryptedToken, username: profile.username };
    atomicWriteJson(this.settingsFile, this._settings);
    return this.getStatus();
  }

  removeAccount(provider) {
    delete this._settings.accounts[assertProvider(provider)];
    atomicWriteJson(this.settingsFile, this._settings);
    return this.getStatus();
  }

  detectRepository(remotes) {
    if (!Array.isArray(remotes)) return null;
    for (const remote of remotes) {
      const parsed = parseRemoteUrl(remote?.refs?.fetch || remote?.refs?.push || remote?.url || '');
      if (!parsed) continue;
      const provider = Object.keys(PROVIDERS).find(id => {
        const account = this._settings.accounts[id];
        const accountHost = account ? new URL(account.baseUrl).hostname.replace(/^api\./, '') : '';
        return parsed.host === PROVIDERS[id].host || parsed.host === accountHost;
      });
      if (provider) return { provider, ...parsed, remote: remote.name || null };
    }
    return null;
  }

  async listPullRequests(repository) {
    const repo = this._assertRepository(repository);
    const account = this._settings.accounts[repo.provider];
    const token = this._token(repo.provider);
    let endpoint;
    if (repo.provider === 'github') endpoint = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=open&per_page=50`;
    if (repo.provider === 'gitlab') endpoint = `/projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}/merge_requests?state=opened&per_page=50`;
    if (repo.provider === 'bitbucket') endpoint = `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pullrequests?state=OPEN&pagelen=50`;
    const response = await this._request(repo.provider, account.baseUrl, token, 'GET', endpoint);
    const items = repo.provider === 'bitbucket' ? response.values || [] : response;
    if (!Array.isArray(items)) throw new Error('Provider returned an invalid pull-request list');
    return items.slice(0, 50).map(item => ({
      id: String(item.number ?? item.iid ?? item.id ?? ''),
      title: String(item.title || '').slice(0, 1000),
      author: String(item.user?.login || item.author?.username || item.author?.display_name || '').slice(0, 256),
      source: String(item.head?.ref || item.source_branch || item.source?.branch?.name || '').slice(0, 1024),
      target: String(item.base?.ref || item.target_branch || item.destination?.branch?.name || '').slice(0, 1024),
      url: this._safeWebUrl(item.html_url || item.web_url || item.links?.html?.href)
    }));
  }

  async createPullRequest(repository, input) {
    const repo = this._assertRepository(repository);
    const title = assertSingleLine(input?.title, 'Pull request title', { maxLength: 500 });
    const source = assertRefName(input?.source, 'Source branch');
    const target = assertRefName(input?.target, 'Target branch');
    const description = typeof input?.description === 'string' && input.description.length <= 100_000 && !input.description.includes('\0')
      ? input.description
      : '';
    const account = this._settings.accounts[repo.provider];
    const token = this._token(repo.provider);
    let endpoint;
    let body;
    if (repo.provider === 'github') {
      endpoint = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`;
      body = { title, head: source, base: target, body: description };
    } else if (repo.provider === 'gitlab') {
      endpoint = `/projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}/merge_requests`;
      body = { title, source_branch: source, target_branch: target, description };
    } else {
      endpoint = `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pullrequests`;
      body = { title, description, source: { branch: { name: source } }, destination: { branch: { name: target } } };
    }
    const result = await this._request(repo.provider, account.baseUrl, token, 'POST', endpoint, body);
    return {
      id: String(result.number ?? result.iid ?? result.id ?? ''),
      title: String(result.title || title),
      url: this._safeWebUrl(result.html_url || result.web_url || result.links?.html?.href)
    };
  }

  _assertRepository(repository) {
    const provider = assertProvider(repository?.provider);
    const owner = String(repository?.owner || '');
    const repo = String(repository?.repo || '');
    if (!owner || owner.length > 1000 || !repo || repo.length > 256 || !/^[A-Za-z0-9_.\/-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error('Provider repository coordinates are invalid');
    }
    return { provider, owner, repo };
  }

  async _profile(provider, baseUrl, token) {
    const endpoint = provider === 'bitbucket' ? '/user' : '/user';
    const result = await this._request(provider, baseUrl, token, 'GET', endpoint);
    const username = result.login || result.username || result.nickname || result.name;
    if (typeof username !== 'string' || !username) throw new Error('Provider token was accepted but no account identity was returned');
    return { username: username.slice(0, 256) };
  }

  _safeWebUrl(value) {
    if (!value) return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' ? parsed.href : null;
    } catch { return null; }
  }

  _request(provider, baseUrl, token, method, endpoint, body) {
    const target = new URL(`${baseUrl}${endpoint}`);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'KitsuneGIT',
      Authorization: `Bearer ${token}`
    };
    if (provider === 'github') headers.Accept = 'application/vnd.github+json';
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      const request = https.request(target, { method, headers }, response => {
        const chunks = [];
        let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) request.destroy(new Error('Provider response exceeded 4 MiB'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try { parsed = text ? JSON.parse(text) : {}; } catch { return reject(new Error('Provider returned an invalid JSON response')); }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            const detail = parsed.message || parsed.error_description || parsed.error?.message || `HTTP ${response.statusCode}`;
            return reject(new Error(`${PROVIDERS[provider].name}: ${String(detail).slice(0, 1000)}`));
          }
          resolve(parsed);
        });
      });
      request.once('error', reject);
      request.setTimeout(20_000, () => request.destroy(new Error('Provider request timed out')));
      if (payload) request.end(payload);
      else request.end();
    });
  }
}

module.exports = { ProviderManager, normalizeBaseUrl, parseRemoteUrl };
