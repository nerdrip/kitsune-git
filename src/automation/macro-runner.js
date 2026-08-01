const { evaluateCondition } = require('./macro-manager');

const STEP_LABELS = {
  stage_all: 'Stage all changes', commit: 'Create commit', fetch: 'Fetch remote', pull: 'Pull branch',
  push: 'Push branch', checkout: 'Switch branch', merge: 'Merge branch', guard: 'Check requirement', condition: 'Evaluate condition'
};

function expandTemplate(template, context) {
  return String(template || '').replace(/\$\{(commitMessage|currentBranch|startBranch)\}/g, (_, name) => String(context[name] || ''));
}

function stepLabel(step) {
  const base = STEP_LABELS[step.type] || step.type;
  if (['checkout', 'merge', 'push', 'pull'].includes(step.type) && step.branch) return `${base}: ${step.branch}`;
  return base;
}

function containsPromptCommit(steps) {
  return steps.some(step => (step.type === 'commit' && step.messageSource === 'prompt')
    || (step.type === 'condition' && (containsPromptCommit(step.thenSteps) || containsPromptCommit(step.elseSteps))));
}

class MacroRunner {
  constructor({ gitService, onProgress = () => {} }) {
    if (!gitService) throw new Error('A Git service is required to run a macro');
    this.gitService = gitService;
    this.onProgress = onProgress;
  }

  async run(macro, input = {}) {
    const initialStatus = await this.gitService.getStatus();
    if (!initialStatus.current) throw new Error('Macros require a checked-out local branch');
    const context = {
      commitMessage: typeof input.commitMessage === 'string' ? input.commitMessage.trim() : '',
      currentBranch: initialStatus.current,
      startBranch: initialStatus.current,
      trigger: input.trigger || 'manual'
    };
    if (containsPromptCommit(macro.steps) && !context.commitMessage) throw new Error('This macro requires a commit message');
    const result = {
      macroId: macro.id, macroName: macro.name, trigger: context.trigger, startBranch: context.startBranch,
      startedAt: new Date().toISOString(), completedAt: null, steps: [], status: null
    };
    this._emit({ phase: 'macro-start', macroId: macro.id, macroName: macro.name });
    try {
      await this._runSteps(macro.steps, context, result, []);
      result.status = await this.gitService.getStatus();
      result.completedAt = new Date().toISOString();
      this._emit({ phase: 'macro-complete', macroId: macro.id, macroName: macro.name, result });
      return result;
    } catch (error) {
      result.status = await this.gitService.getStatus().catch(() => null);
      result.completedAt = new Date().toISOString();
      this._emit({ phase: 'macro-failed', macroId: macro.id, macroName: macro.name, message: error.message, result });
      const wrapped = new Error(`Macro “${macro.name}” stopped: ${error.message}`);
      wrapped.cause = error;
      wrapped.macroResult = result;
      throw wrapped;
    }
  }

  _emit(event) {
    try { this.onProgress(event); } catch { /* observers cannot break Git operations */ }
  }

  async _runSteps(steps, context, result, parentPath) {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const stepPath = [...parentPath, index];
      const log = { id: step.id, type: step.type, label: stepLabel(step), path: stepPath, status: 'running' };
      result.steps.push(log);
      this._emit({ phase: 'step-start', macroId: result.macroId, step: { ...log } });
      try {
        await this._runStep(step, context, result, stepPath);
        log.status = 'completed';
        this._emit({ phase: 'step-complete', macroId: result.macroId, step: { ...log } });
      } catch (error) {
        log.status = 'failed';
        log.error = error.message;
        this._emit({ phase: 'step-failed', macroId: result.macroId, step: { ...log } });
        throw new Error(`${log.label}: ${error.message}`);
      }
    }
  }

  async _runStep(step, context, result, stepPath) {
    let status = null;
    if (step.type === 'stage_all') {
      status = await this.gitService.stageAll();
    } else if (step.type === 'commit') {
      if (context.trigger === 'after_commit') throw new Error('After-commit hooks cannot create another commit');
      const message = step.messageSource === 'prompt' ? context.commitMessage : expandTemplate(step.message, context);
      if (!message.trim()) throw new Error('Commit message is blank');
      status = await this.gitService.commit(message);
      context.commitMessage = message;
    } else if (step.type === 'fetch') {
      status = await this.gitService.fetch(step.remote || undefined, step.prune);
    } else if (step.type === 'pull') {
      status = await this.gitService.pull(step.remote, expandTemplate(step.branch, context) || undefined, step.rebase);
    } else if (step.type === 'push') {
      const branch = expandTemplate(step.branch, context) || undefined;
      status = step.setUpstream
        ? await this.gitService.pushWithUpstream(step.remote, branch)
        : await this.gitService.push(step.remote, branch, false);
    } else if (step.type === 'checkout') {
      status = await this.gitService.checkout(expandTemplate(step.branch, context));
    } else if (step.type === 'merge') {
      status = await this.gitService.merge(expandTemplate(step.branch, context), step.noFf);
    } else if (step.type === 'guard') {
      if (!evaluateCondition(step.condition, context)) throw new Error(step.message);
    } else if (step.type === 'condition') {
      const matched = evaluateCondition(step.condition, context);
      const branch = matched ? step.thenSteps : step.elseSteps;
      const conditionLog = result.steps.find(item => item.id === step.id && item.path.join('.') === stepPath.join('.'));
      if (conditionLog) conditionLog.outcome = matched ? 'then' : 'else';
      await this._runSteps(branch, context, result, [...stepPath, matched ? 'then' : 'else']);
    }
    if (status?.current) context.currentBranch = status.current;
  }
}

module.exports = { MacroRunner, containsPromptCommit, expandTemplate, stepLabel };
