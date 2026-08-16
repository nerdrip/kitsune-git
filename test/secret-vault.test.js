const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { SecretVault } = require('../src/server/secret-vault');
const { coordinates } = require('../src/server/provider-import-service');

describe('server secret storage and provider coordinates', () => {
  it('encrypts mirror credentials with authenticated encryption', () => {
    const vault = new SecretVault('ab'.repeat(32));
    const encrypted = vault.encrypt('provider-secret');
    assert.notEqual(encrypted, 'provider-secret');
    assert.equal(vault.decrypt(encrypted), 'provider-secret');
    assert.throws(() => vault.decrypt(`${encrypted.slice(0, -2)}aa`));
  });

  it('extracts GitHub and nested GitLab project paths', () => {
    assert.deepEqual(coordinates('github', 'https://github.com/acme/widget.git'), { owner: 'acme', repo: 'widget', fullPath: 'acme/widget' });
    assert.deepEqual(coordinates('gitlab', 'https://gitlab.example/acme/platform/widget.git'), { owner: 'acme/platform', repo: 'widget', fullPath: 'acme/platform/widget' });
  });
});
