const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { KitsuneServerManager, normalizeServerUrl } = require('../src/integrations/kitsune-server-manager');

describe('KitsuneGIT server integration', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-desktop-server-')); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('requires HTTPS except for loopback development', () => {
    assert.equal(normalizeServerUrl('https://git.example.test/'), 'https://git.example.test');
    assert.equal(normalizeServerUrl('http://127.0.0.1:4780'), 'http://127.0.0.1:4780');
    assert.throws(() => normalizeServerUrl('http://git.example.test'), /HTTPS/);
    assert.throws(() => normalizeServerUrl('https://user:secret@git.example.test'), /clean URL/);
  });

  it('does not persist a token without OS encryption', async () => {
    const manager = new KitsuneServerManager({ userDataPath: root, safeStorage: { isEncryptionAvailable: () => false } });
    await assert.rejects(manager.connect({ baseUrl: 'https://git.example.test', token: 'a'.repeat(32) }), /credential storage/);
    assert.equal(manager.status().configured, false);
  });
});
