const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { ProfileManager, normalizeProfile } = require('../src/main/profile-manager');

describe('repository profiles', () => {
  let directory;

  before(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-profiles-')); });
  after(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('validates identity and runtime configuration', () => {
    const profile = normalizeProfile({
      name: 'Work', identityName: 'Kitsune User', identityEmail: 'user@example.test',
      runtimeMode: 'managed', autocrlf: 'input', pullRebase: 'true'
    });
    assert.equal(profile.runtimeMode, 'managed');
    assert.equal(profile.autocrlf, 'input');
    assert.throws(() => normalizeProfile({ name: '../bad', identityEmail: 'bad' }), /Profile name|email/);
    assert.throws(() => normalizeProfile({ name: 'Custom', runtimeMode: 'custom' }), /Custom Git path/);
  });

  it('persists, replaces, and removes named profiles', () => {
    const manager = new ProfileManager({ userDataPath: directory });
    manager.save({ name: 'Personal', identityName: 'First', runtimeMode: 'auto' });
    manager.save({ name: 'Personal', identityName: 'Updated', runtimeMode: 'system' });
    assert.equal(manager.list().length, 1);
    assert.equal(manager.get('Personal').identityName, 'Updated');
    manager.remove('Personal');
    assert.deepEqual(manager.list(), []);
  });
});
