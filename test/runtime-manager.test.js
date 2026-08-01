const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  compareVersions,
  normalizeExecutablePath,
  parseGitVersion
} = require('../src/git/runtime-manager');

describe('Git runtime validation', () => {
  it('parses Git for Windows and standard version output', () => {
    assert.equal(parseGitVersion('git version 2.55.0.windows.3'), '2.55.0');
    assert.equal(parseGitVersion('git version 2.51.2'), '2.51.2');
    assert.equal(parseGitVersion('not git'), null);
  });

  it('compares versions numerically', () => {
    assert.ok(compareVersions('2.55.0', '2.30.0') > 0);
    assert.ok(compareVersions('2.9.10', '2.10.0') < 0);
    assert.equal(compareVersions('2.55.0.3', '2.55.0.3'), 0);
  });

  it('rejects missing executable paths', () => {
    assert.throws(() => normalizeExecutablePath('\0bad'), /invalid/);
    assert.throws(() => normalizeExecutablePath('definitely-missing-kitsune-git'), /does not exist/);
  });
});
