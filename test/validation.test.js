const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const {
  assertRefName,
  assertRemoteName,
  assertRevision,
  assertStashIndex,
  canonicalizeFileSystemPath,
  literalPathspec,
  normalizeMaxCount,
  normalizeRelativePath,
  pathsEqual,
  sanitizeGitEnvironment
} = require('../src/git/validation');

describe('Git input validation', () => {
  let repository;

  before(() => {
    repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-validation-'));
  });

  after(() => {
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('normalizes safe repository-relative paths', () => {
    assert.equal(normalizeRelativePath(repository, 'src\\main.js'), 'src/main.js');
    assert.equal(literalPathspec(repository, '--unusual.txt'), ':(literal)--unusual.txt');
  });

  it('compares canonical filesystem paths', () => {
    assert.equal(canonicalizeFileSystemPath(path.join(repository, '.')), fs.realpathSync.native(repository));
    assert.equal(pathsEqual(repository, path.join(repository, '.')), true);
    if (process.platform === 'win32') assert.equal(pathsEqual(repository, repository.toUpperCase()), true);
  });

  it('rejects absolute paths and traversal', () => {
    assert.throws(() => normalizeRelativePath(repository, '../secret.txt'), /outside the repository/);
    assert.throws(() => normalizeRelativePath(repository, path.resolve(repository, 'file.txt')), /repository-relative/);
    assert.throws(() => normalizeRelativePath(repository, 'safe\0unsafe'), /null character/);
  });

  it('accepts valid refs and rejects option-like or malformed refs', () => {
    assert.equal(assertRefName('feature/audit-fix'), 'feature/audit-fix');
    assert.equal(assertRefName('origin/main'), 'origin/main');
    for (const invalid of ['--help', '../main', 'bad ref', 'topic..other', 'name@{1}', '.hidden']) {
      assert.throws(() => assertRefName(invalid), /valid Git reference/);
    }
  });

  it('validates hashes, remotes, stash indexes, and bounded log sizes', () => {
    assert.equal(assertRevision('0123456789abcdef'), '0123456789abcdef');
    assert.equal(assertRemoteName('origin-2'), 'origin-2');
    assert.equal(assertStashIndex(4), 4);
    assert.equal(normalizeMaxCount(50), 50);
    assert.equal(normalizeMaxCount(5000), 1000);
    assert.throws(() => assertRevision('HEAD'), /hexadecimal hash/);
    assert.throws(() => assertRemoteName('-origin'), /invalid characters/);
    assert.throws(() => assertStashIndex(-1), /non-negative integer/);
  });

  it('removes inherited Git redirection, config injection, editor, and pager variables', () => {
    const environment = sanitizeGitEnvironment({
      PATH: 'safe-path',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/unexpected',
      GIT_DIR: '/other/repository',
      GIT_PAGER: 'less',
      PAGER: 'more',
      GIT_EDITOR: 'external-editor',
      GIT_SSH_COMMAND: 'untrusted ssh command'
    });
    assert.deepEqual(environment, { PATH: 'safe-path' });
  });
});
