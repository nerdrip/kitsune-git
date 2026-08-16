const crypto = require('node:crypto');

class SecretVault {
  constructor(key) {
    if (!/^[a-f0-9]{64}$/i.test(String(key || ''))) throw new Error('KITSUNE_SECRET_KEY must be a 32-byte hexadecimal key');
    this.key = Buffer.from(key, 'hex');
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
  }

  decrypt(envelope) {
    const [iv, tag, encrypted] = String(envelope || '').split('.').map(value => Buffer.from(value, 'base64'));
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !encrypted) throw new Error('Stored mirror credential is invalid');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}

module.exports = { SecretVault };
