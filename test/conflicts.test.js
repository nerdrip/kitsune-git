const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const GitService = require('../src/git/git-service');

describe('Git conflict operations', { concurrency: 1 }, () => {
  let repository;
  let service;
  let primaryBranch;

  before(async () => {
    repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-conflict-'));
    service = new GitService(repository);
    await service.init();
    await service.setConfig('user.name', 'Kitsune Conflict Test');
    await service.setConfig('user.email', 'conflict@example.test');
    fs.writeFileSync(path.join(repository, 'shared.txt'), 'base\n', 'utf8');
    await service.stage(['shared.txt']);
    await service.commit('base');
    primaryBranch = (await service.getStatus()).current;

    await service.createBranch('conflicting-side');
    fs.writeFileSync(path.join(repository, 'shared.txt'), 'theirs\n', 'utf8');
    await service.stage(['shared.txt']);
    await service.commit('theirs');

    await service.checkout(primaryBranch);
    fs.writeFileSync(path.join(repository, 'shared.txt'), 'ours\n', 'utf8');
    await service.stage(['shared.txt']);
    await service.commit('ours');
    await assert.rejects(service.merge('conflicting-side'));
  });

  after(() => {
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('returns all index stages and resolves the operation', async () => {
    const operation = await service.getOperationState();
    assert.equal(operation.type, 'merge');
    assert.deepEqual(operation.conflicted.map(file => file.path), ['shared.txt']);

    const conflict = await service.getConflictFile('shared.txt');
    assert.equal(conflict.base, 'base\n');
    assert.equal(conflict.ours, 'ours\n');
    assert.equal(conflict.theirs, 'theirs\n');
    assert.match(conflict.current, /<<<<<<< HEAD/);

    await service.saveConflictResolution('shared.txt', 'resolved\n');
    await service.continueOperation();
    assert.equal((await service.getOperationState()).inProgress, false);
    assert.equal(fs.readFileSync(path.join(repository, 'shared.txt'), 'utf8'), 'resolved\n');
  });
});
