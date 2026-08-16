const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

function normalizeServerUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw new Error('KitsuneGIT server URL is invalid'); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if ((!local && parsed.protocol !== 'https:') || (local && !['http:', 'https:'].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('KitsuneGIT server must use HTTPS (HTTP is allowed only on localhost) and a clean URL');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

class KitsuneServerManager {
  constructor({ userDataPath, safeStorage, askPassPath = path.join(__dirname, 'kitsune-askpass.js') }) {
    this.safeStorage = safeStorage;
    this.file = path.join(path.resolve(userDataPath), 'kitsune-server.json');
    this.askPassPath = askPassPath;
    this.settings = this._read();
  }

  _read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { baseUrl: normalizeServerUrl(value.baseUrl), encryptedToken: String(value.encryptedToken || '') };
    } catch { return null; }
  }

  _encryptionAvailable() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.()) && this.safeStorage?.getSelectedStorageBackend?.() !== 'basic_text';
  }

  _token() {
    if (!this.settings) throw new Error('KitsuneGIT server is not connected');
    if (!this._encryptionAvailable()) throw new Error('Secure operating-system credential storage is unavailable');
    try { return this.safeStorage.decryptString(Buffer.from(this.settings.encryptedToken, 'base64')); }
    catch { throw new Error('KitsuneGIT server token cannot be decrypted'); }
  }

  status() {
    return { configured: Boolean(this.settings), baseUrl: this.settings?.baseUrl || null, encryptionAvailable: this._encryptionAvailable() };
  }

  async connect(input) {
    if (!this._encryptionAvailable()) throw new Error('Secure operating-system credential storage is unavailable');
    const baseUrl = normalizeServerUrl(input?.baseUrl);
    const token = String(input?.token || '');
    if (token.length < 24 || token.length > 8192 || /[\0\r\n]/.test(token)) throw new Error('Administrator token is invalid');
    await this._request('/api/v1/projects', token, baseUrl);
    this.settings = { baseUrl, encryptedToken: this.safeStorage.encryptString(token).toString('base64') };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return this.status();
  }

  disconnect() {
    this.settings = null;
    fs.rmSync(this.file, { force: true });
    return this.status();
  }

  async projects() {
    const result = await this._request('/api/v1/projects', this._token(), this.settings.baseUrl);
    return Array.isArray(result.projects) ? result.projects : [];
  }

  async search(query) {
    const value = String(query || '').trim();
    if (value.length < 2 || value.length > 200) throw new Error('Search requires 2–200 characters');
    return await this._request(`/api/v1/search?q=${encodeURIComponent(value)}`, this._token(), this.settings.baseUrl);
  }

  async notifications() {
    const result = await this._request('/api/v1/notifications?unread=true', this._token(), this.settings.baseUrl);
    return Array.isArray(result.notifications) ? result.notifications : [];
  }

  async markNotificationRead(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id || ''))) throw new Error('Notification ID is invalid');
    return await this._request(`/api/v1/notifications/${id}/read`, this._token(), this.settings.baseUrl, { method: 'POST' });
  }

  async syncDrafts(input) { return await this._request('/api/v1/sync/drafts', this._token(), this.settings.baseUrl, { method: 'POST', body: input }); }
  async publishDraft(id) { if (!/^[0-9a-f-]{36}$/.test(String(id || ''))) throw new Error('Draft ID is invalid'); return await this._request(`/api/v1/drafts/${id}/publish`, this._token(), this.settings.baseUrl, { method: 'POST' }); }

  async cloneConfiguration(projectId) {
    const projects = await this.projects();
    const project = projects.find(item => item.id === projectId);
    if (!project) throw new Error('KitsuneGIT project not found');
    return {
      url: `${this.settings.baseUrl}/git/${encodeURIComponent(project.namespace)}/${encodeURIComponent(project.slug)}.git`,
      environment: {
        GIT_ASKPASS: this.askPassPath,
        GIT_TERMINAL_PROMPT: '0',
        KITSUNE_ASKPASS_TOKEN: this._token()
      }
    };
  }

  _request(route, token, baseUrl, options = {}) {
    const target = new URL(route, `${baseUrl}/`);
    const transport = target.protocol === 'http:' ? http : https;
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    return new Promise((resolve, reject) => {
      const request = transport.request(target, { method: options.method || 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'KitsuneGIT-Desktop', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) request.destroy(new Error('Server response exceeded 4 MiB')); else chunks.push(chunk); });
        response.once('error', reject);
        response.once('end', () => {
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return reject(new Error('KitsuneGIT server returned invalid JSON')); }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(String(body.error || `HTTP ${response.statusCode}`).slice(0, 1000)));
          resolve(body);
        });
      });
      request.setTimeout(15_000, () => request.destroy(new Error('KitsuneGIT server request timed out')));
      request.once('error', reject);
      request.end(payload);
    });
  }
}

module.exports = { KitsuneServerManager, normalizeServerUrl };
