const crypto = require('node:crypto');
const { utils } = require('ssh2');
const { text } = require('./validation');

function parsePublicKey(value) {
  const parsed = utils.parseKey(String(value || '').trim());
  if (parsed instanceof Error || Array.isArray(parsed) || !parsed || typeof parsed.isPrivateKey !== 'function') {
    throw Object.assign(new Error('SSH public key is invalid'), { statusCode: 400 });
  }
  if (parsed.isPrivateKey()) throw Object.assign(new Error('Provide a public SSH key, not a private key'), { statusCode: 400 });
  if (parsed.type === 'ssh-dss') throw Object.assign(new Error('DSA SSH keys are not supported'), { statusCode: 400 });
  const blob = parsed.getPublicSSH();
  return {
    parsed,
    blob,
    fingerprint: `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
    publicKey: `${parsed.type} ${blob.toString('base64')}`
  };
}

class SshKeyService {
  constructor({ store }) { this.store = store; }

  _requireOwner(userId, actor) {
    if (!actor?.admin && actor?.id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const user = this.store.snapshot().users.find(item => item.id === userId && !item.blocked);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    return user;
  }

  list(userId, actor) {
    this._requireOwner(userId, actor);
    return this.store.snapshot().sshKeys.filter(item => item.userId === userId);
  }

  create(userId, input, actor) {
    const user = this._requireOwner(userId, actor);
    const key = parsePublicKey(input.publicKey);
    if (this.store.snapshot().sshKeys.some(item => item.fingerprint === key.fingerprint)) {
      throw Object.assign(new Error('SSH key is already registered'), { statusCode: 409 });
    }
    const saved = {
      id: crypto.randomUUID(),
      userId,
      title: text(input.title || key.fingerprint, 'SSH key title', { required: true, max: 256 }),
      type: key.parsed.type,
      fingerprint: key.fingerprint,
      publicKey: key.publicKey,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    };
    return this.store.update(state => { state.sshKeys.push(saved); return saved; }, { actor: actor.username, action: 'ssh_key.create', target: `${user.username}:${saved.id}` });
  }

  remove(userId, keyId, actor) {
    this._requireOwner(userId, actor);
    return this.store.update(state => {
      const index = state.sshKeys.findIndex(item => item.id === keyId && item.userId === userId);
      if (index < 0) throw Object.assign(new Error('SSH key not found'), { statusCode: 404 });
      return state.sshKeys.splice(index, 1)[0];
    }, { actor: actor.username, action: 'ssh_key.remove', target: keyId });
  }

  authenticate(key, signature = null) {
    const state = this.store.snapshot();
    for (const item of state.sshKeys) {
      const parsed = utils.parseKey(item.publicKey);
      const publicBlob = parsed instanceof Error ? null : parsed.getPublicSSH();
      if (!publicBlob || parsed.type !== key.algo || publicBlob.length !== key.data.length || !crypto.timingSafeEqual(publicBlob, key.data)) continue;
      if (signature && parsed.verify(signature.blob, signature.value, signature.hashAlgo) !== true) continue;
      const user = state.users.find(candidate => candidate.id === item.userId && !candidate.blocked);
      if (!user) continue;
      if (signature) this.store.update(draft => { const current = draft.sshKeys.find(candidate => candidate.id === item.id); if (current) current.lastUsedAt = new Date().toISOString(); return null; });
      return { id: user.id, username: user.username, name: user.name, admin: Boolean(user.admin) };
    }
    return null;
  }
}

module.exports = { SshKeyService, parsePublicKey };
