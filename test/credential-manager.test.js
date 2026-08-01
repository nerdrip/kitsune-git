const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  assertKeyComment,
  assertKeyName,
  assertSshHost,
  parseFingerprint
} = require('../src/auth/credential-manager');

describe('credential and SSH input validation', () => {
  it('validates key names, comments, and hosts', () => {
    assert.equal(assertKeyName('id_ed25519_work'), 'id_ed25519_work');
    assert.equal(assertKeyComment('dev@example.test'), 'dev@example.test');
    assert.equal(assertSshHost('GitHub.COM'), 'github.com');
    assert.throws(() => assertKeyName('../id_key'), /Key name/);
    assert.throws(() => assertKeyComment('name\ncommand'), /unsupported/);
    assert.throws(() => assertSshHost('-bad.example'), /invalid/);
  });

  it('parses OpenSSH fingerprints', () => {
    assert.deepEqual(
      parseFingerprint('256 SHA256:abc123 dev@example.test (ED25519)'),
      { bits: 256, fingerprint: 'SHA256:abc123', comment: 'dev@example.test', algorithm: 'ED25519' }
    );
  });
});
