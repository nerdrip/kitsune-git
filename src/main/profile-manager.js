const fs = require('node:fs');
const path = require('node:path');
const { assertSingleLine } = require('../git/validation');

const MODES = new Set(['auto', 'system', 'managed', 'custom']);

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'win32') fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
}

function normalizeProfile(input) {
  if (!input || typeof input !== 'object') throw new Error('Profile data is required');
  const name = assertSingleLine(input.name, 'Profile name', { maxLength: 64 }).trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(name)) throw new Error('Profile name contains unsupported characters');
  const identityName = input.identityName ? assertSingleLine(input.identityName, 'Git user name', { maxLength: 256 }).trim() : '';
  const identityEmail = input.identityEmail ? assertSingleLine(input.identityEmail, 'Git email', { maxLength: 320 }).trim() : '';
  if (identityEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identityEmail)) throw new Error('Profile email is invalid');
  const runtimeMode = MODES.has(input.runtimeMode) ? input.runtimeMode : 'auto';
  const runtimePath = runtimeMode === 'custom'
    ? assertSingleLine(input.runtimePath, 'Custom Git path', { maxLength: 32_767 }).trim()
    : '';
  const sshKeyPath = input.sshKeyPath ? assertSingleLine(input.sshKeyPath, 'SSH key path', { maxLength: 32_767 }).trim() : '';
  const autocrlf = ['true', 'false', 'input', ''].includes(input.autocrlf) ? input.autocrlf : '';
  const pullRebase = ['true', 'false', 'merges', 'interactive', ''].includes(input.pullRebase) ? input.pullRebase : '';
  return { name, identityName, identityEmail, runtimeMode, runtimePath, sshKeyPath, autocrlf, pullRebase };
}

class ProfileManager {
  constructor({ userDataPath }) {
    this.filePath = path.join(path.resolve(userDataPath), 'profiles.json');
    this._profiles = this._read();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed.profiles)) return [];
      const profiles = [];
      for (const profile of parsed.profiles.slice(0, 100)) {
        try { profiles.push(normalizeProfile(profile)); } catch { /* ignore invalid persisted entries */ }
      }
      return profiles;
    } catch { return []; }
  }

  _save() {
    atomicWriteJson(this.filePath, { version: 1, profiles: this._profiles });
  }

  list() {
    return this._profiles.map(profile => ({ ...profile }));
  }

  get(name) {
    const safeName = assertSingleLine(name, 'Profile name', { maxLength: 64 });
    const profile = this._profiles.find(item => item.name === safeName);
    if (!profile) throw new Error(`Profile does not exist: ${safeName}`);
    return { ...profile };
  }

  save(input) {
    const profile = normalizeProfile(input);
    const index = this._profiles.findIndex(item => item.name === profile.name);
    if (index >= 0) this._profiles[index] = profile;
    else this._profiles.push(profile);
    this._profiles = this._profiles.slice(-100).sort((left, right) => left.name.localeCompare(right.name));
    this._save();
    return this.list();
  }

  remove(name) {
    const profile = this.get(name);
    this._profiles = this._profiles.filter(item => item.name !== profile.name);
    this._save();
    return this.list();
  }
}

module.exports = { ProfileManager, normalizeProfile };
