const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const GitService = require('../src/git/git-service');

describe('advanced Git tools', { concurrency: 1 }, () => {
  let root;
  let repository;
  let service;
  let hashes;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-advanced-'));
    repository = path.join(root, 'repository');
    fs.mkdirSync(repository);
    service = new GitService(repository);
    await service.init();
    await service.setConfig('user.name', 'Kitsune Advanced Test');
    await service.setConfig('user.email', 'advanced@example.test');
    hashes = [];
    for (const value of ['one', 'two', 'three']) {
      fs.writeFileSync(path.join(repository, 'history.txt'), `${value}\n`, 'utf8');
      fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repository, 'src', `${value}.txt`), `${value}\n`, 'utf8');
      await service.stageAll();
      await service.commit(value);
      hashes.push((await service.getLog(1))[0].hash);
    }
  });

  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('lists reflog entries and recovers a commit to a branch', async () => {
    const reflog = await service.getReflog(20);
    assert.ok(reflog.some(entry => entry.hash === hashes[0]));
    await service.recoverToBranch(hashes[0], 'recovered-first');
    assert.ok((await service.getBranches()).local.includes('recovered-first'));
  });

  it('adds, lists, and removes a secondary worktree', async () => {
    const worktreePath = path.join(root, 'worktree');
    await service.addWorktree({ path: worktreePath, newBranch: 'worktree-test', startPoint: hashes[1] });
    assert.ok((await service.getWorktrees()).some(item => path.resolve(item.path) === path.resolve(worktreePath)));
    await service.removeWorktree(worktreePath);
    assert.ok(!(await service.getWorktrees()).some(item => path.resolve(item.path) === path.resolve(worktreePath)));
  });

  it('runs a bisect session and resets it', async () => {
    const status = await service.startBisect(hashes[0], hashes[2]);
    assert.equal(status.active, true);
    assert.equal(status.current, hashes[1]);
    const marked = await service.markBisect('bad');
    assert.match(marked.output, /first bad commit/i);
    await service.resetBisect();
    assert.equal((await service.getBisectStatus()).active, false);
  });

  it('executes a validated interactive rebase plan with a recovery ref', async () => {
    const preview = await service.previewInteractiveRebase(hashes[0]);
    assert.deepEqual(preview.commits.map(commit => commit.hash), [hashes[1], hashes[2]]);
    const result = await service.startInteractiveRebase(hashes[0], [
      { hash: hashes[1], action: 'pick' },
      { hash: hashes[2], action: 'squash', message: 'combine third change' }
    ]);
    assert.match(result.backupRef, /^refs\/kitsune\/backups\/rebase-/);
    assert.equal((await service.getOperationState()).inProgress, false);
    const rewritten = await service.previewInteractiveRebase(hashes[0]);
    assert.equal(rewritten.commits.length, 1);
    const backup = (await service.git.raw(['rev-parse', result.backupRef])).trim();
    assert.equal(backup, hashes[2]);
  });

  it('enables and disables cone-mode sparse checkout', async () => {
    await service.setSparsePaths(['src']);
    assert.deepEqual(await service.getSparseStatus(), { enabled: true, paths: ['src'] });
    await service.disableSparseCheckout();
    assert.equal((await service.getSparseStatus()).enabled, false);
  });

  it('exports a commit as a mailbox patch and reports optional LFS', async () => {
    const patch = await service.createMailboxPatch(hashes[1]);
    assert.match(patch, /^From [0-9a-f]{40}/);
    assert.match(patch, /Subject: \[PATCH\] two/);
    const lfs = await service.getLfsStatus();
    assert.equal(typeof lfs.available, 'boolean');
  });
});
