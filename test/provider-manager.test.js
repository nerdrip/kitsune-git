const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { ProviderManager, normalizeBaseUrl, parseRemoteUrl } = require('../src/integrations/provider-manager');

describe('provider integrations', () => {
  let userDataPath;

  before(() => { userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-providers-')); });
  after(() => { fs.rmSync(userDataPath, { recursive: true, force: true }); });

  it('detects HTTPS, SSH URL, and SCP-like repository remotes', () => {
    assert.deepEqual(parseRemoteUrl('https://github.com/acme/widgets.git'), { host: 'github.com', owner: 'acme', repo: 'widgets' });
    assert.deepEqual(parseRemoteUrl('git@gitlab.com:group/project.git'), { host: 'gitlab.com', owner: 'group', repo: 'project' });
    assert.deepEqual(parseRemoteUrl('ssh://git@bitbucket.org/team/repo.git'), { host: 'bitbucket.org', owner: 'team', repo: 'repo' });
    assert.equal(parseRemoteUrl('file:///tmp/repo'), null);
  });

  it('requires clean HTTPS API URLs', () => {
    assert.equal(normalizeBaseUrl('', 'github'), 'https://api.github.com');
    assert.throws(() => normalizeBaseUrl('http://git.example.test/api', 'gitlab'), /HTTPS/);
    assert.throws(() => normalizeBaseUrl('https://user:pass@example.test', 'gitlab'), /HTTPS/);
  });

  it('refuses token persistence without a secure OS backend', async () => {
    const manager = new ProviderManager({
      userDataPath,
      safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' }
    });
    assert.equal(manager.getStatus().encryption.available, false);
    await assert.rejects(manager.saveAccount({ provider: 'github', token: 'github-token-value' }), /secure operating-system/);
  });
});
