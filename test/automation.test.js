const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const { MacroManager, createStarterMacro, evaluateCondition, normalizeMacro } = require('../src/automation/macro-manager');
const { MacroRunner, expandTemplate } = require('../src/automation/macro-runner');

function fakeGitService(startBranch = 'develop') {
  const calls = [];
  let current = startBranch;
  const status = () => ({ current, isClean: true, staged: [], modified: [], repoPath: '/repository' });
  return {
    calls,
    getStatus: async () => status(),
    stageAll: async () => { calls.push(['stageAll']); return status(); },
    commit: async message => { calls.push(['commit', message]); return status(); },
    fetch: async (remote, prune) => { calls.push(['fetch', remote, prune]); return status(); },
    pull: async (remote, branch, rebase) => { calls.push(['pull', remote, branch, rebase]); return status(); },
    push: async (remote, branch, force) => { calls.push(['push', remote, branch, force]); return status(); },
    pushWithUpstream: async (remote, branch) => { calls.push(['pushWithUpstream', remote, branch]); return status(); },
    checkout: async branch => { calls.push(['checkout', branch]); current = branch; return status(); },
    merge: async (branch, noFf) => { calls.push(['merge', branch, noFf]); return status(); }
  };
}

describe('visual Git automations', () => {
  it('runs the complete develop-to-main starter flow', async () => {
    const service = fakeGitService();
    const events = [];
    const result = await new MacroRunner({ gitService: service, onProgress: event => events.push(event) })
      .run(createStarterMacro(), { commitMessage: 'feat: automation studio' });
    assert.deepEqual(service.calls, [
      ['stageAll'], ['commit', 'feat: automation studio'], ['push', 'origin', 'develop', false],
      ['checkout', 'main'], ['pull', 'origin', 'main', false], ['merge', 'develop', false],
      ['push', 'origin', 'main', false], ['checkout', 'develop']
    ]);
    assert.equal(result.status.current, 'develop');
    assert.equal(result.steps.every(step => step.status === 'completed'), true);
    assert.equal(events.at(-1).phase, 'macro-complete');
  });

  it('supports nested decisions and safe template variables', async () => {
    const macro = normalizeMacro({ name: 'Conditional publish', steps: [{
      type: 'condition',
      condition: { source: 'commit_message', operator: 'starts_with', value: 'release:' },
      thenSteps: [{ type: 'push', remote: 'origin', branch: '${startBranch}' }],
      elseSteps: [{ type: 'fetch', remote: 'origin' }]
    }] }, { mustExist: false });
    const service = fakeGitService('feature/visual-macros');
    await new MacroRunner({ gitService: service }).run(macro, { commitMessage: 'release: 2.0' });
    assert.deepEqual(service.calls, [['push', 'origin', 'feature/visual-macros', false]]);
    assert.equal(expandTemplate('${startBranch}:${currentBranch}', { startBranch: 'develop', currentBranch: 'main' }), 'develop:main');
  });

  it('prevents recursive after-commit hooks and evaluates filters', () => {
    assert.throws(() => normalizeMacro({
      name: 'Recursive hook', trigger: { event: 'after_commit' },
      steps: [{ type: 'commit', messageSource: 'template', message: 'again' }]
    }, { mustExist: false }), /cannot contain another commit/);
    assert.equal(evaluateCondition(
      { source: 'commit_message', operator: 'contains', value: '[deploy]' },
      { commitMessage: 'fix: issue [DEPLOY]' }
    ), true);
  });

  it('isolates repository-scoped persisted macros', () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-automations-'));
    const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-repository-'));
    const otherRepository = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-other-repository-'));
    after(() => {
      for (const directory of [userDataPath, repositoryPath, otherRepository]) fs.rmSync(directory, { recursive: true, force: true });
    });
    const manager = new MacroManager({ userDataPath });
    const saved = manager.save({ name: 'Only here', scope: 'repository', steps: [{ type: 'fetch', remote: 'origin' }] }, repositoryPath);
    assert.equal(manager.list(repositoryPath).some(macro => macro.id === saved.id), true);
    assert.equal(manager.list(otherRepository).some(macro => macro.id === saved.id), false);
    assert.equal(new MacroManager({ userDataPath }).get(saved.id, repositoryPath).name, 'Only here');
  });
});
