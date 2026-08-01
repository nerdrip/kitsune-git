const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const GitService = require('../src/git/git-service');

describe('GitService integration', { concurrency: 1 }, () => {
  let repository;
  let service;
  let firstHash;

  before(async () => {
    repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-git-service-'));
    service = new GitService(repository);
    await service.init();
    await service.setConfig('user.name', 'Kitsune Audit');
    await service.setConfig('user.email', 'audit@example.test');
  });

  after(() => {
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('stages literal option-like file names and creates a commit', async () => {
    const initialContent = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    fs.writeFileSync(path.join(repository, '--danger.txt'), initialContent, 'utf8');
    const stagedStatus = await service.stage(['--danger.txt']);
    assert.deepEqual(stagedStatus.staged.map(file => file.path), ['--danger.txt']);

    await service.commit('feat: add literal path test');
    const log = await service.getLog(20);
    assert.equal(log[0].message, 'feat: add literal path test');
    assert.equal(log[0].author, 'Kitsune Audit');
    firstHash = log[0].hash;
    assert.match(firstHash, /^[0-9a-f]{40}$/);
  });

  it('reports diffs and prevents repository traversal', async () => {
    fs.appendFileSync(path.join(repository, '--danger.txt'), 'second line\n', 'utf8');
    const diff = await service.getDiff('--danger.txt');
    assert.match(diff, /\+second line/);
    await assert.rejects(service.getDiff('../outside.txt'), /outside the repository/);
  });

  it('returns the new path and old path for renamed commit files', async () => {
    fs.renameSync(path.join(repository, '--danger.txt'), path.join(repository, 'renamed.txt'));
    await service.stageAll();
    await service.commit('refactor: rename test file');
    const [latest] = await service.getLog(1);
    const files = await service.getCommitFiles(latest.hash);
    assert.equal(files.length, 1);
    assert.match(files[0].status, /^R\d{3}$/);
    assert.equal(files[0].path, 'renamed.txt');
    assert.equal(files[0].oldPath, '--danger.txt');
  });

  it('searches commit subjects literally and validates destructive revisions', async () => {
    const results = await service.searchLog('feat: add literal path test', 20);
    assert.equal(results[0].hash, firstHash);
    await assert.rejects(service.reset('--hard', '--hard'), /hexadecimal hash/);
  });

  it('stages and unstages selected lines without touching other changes', async () => {
    const filePath = path.join(repository, 'partial.txt');
    fs.writeFileSync(filePath, 'one\nold\nthree\n', 'utf8');
    await service.stage(['partial.txt']);
    await service.commit('test: add partial staging fixture');
    fs.writeFileSync(filePath, 'one\nnew\nthree\nadded\n', 'utf8');

    await service.applySelection('partial.txt', [{ hunk: 0, lines: [1, 2] }], 'stage');
    const staged = await service.getDiffCached('partial.txt');
    const unstaged = await service.getDiff('partial.txt');
    assert.match(staged, /^-old$/m);
    assert.match(staged, /^\+new$/m);
    assert.doesNotMatch(staged, /^\+added$/m);
    assert.match(unstaged, /^\+added$/m);

    await service.applySelection('partial.txt', [{ hunk: 0 }], 'unstage');
    assert.equal(await service.getDiffCached('partial.txt'), '');
    assert.match(await service.getDiff('partial.txt'), /^\+added$/m);
    await service.stageAll();
    await service.commit('test: finish partial staging fixture');
  });

  it('exposes only supported repository configuration', async () => {
    await service.git.raw(['config', '--local', 'remote.origin.url', 'https://user:secret@example.test/repo.git']);
    const config = await service.getConfig();
    assert.equal(config['user.name'], 'Kitsune Audit');
    assert.equal(config['user.email'], 'audit@example.test');
    assert.equal(config['remote.origin.url'], undefined);
  });
});
