const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertRemoteName, assertSingleLine, normalizeRepositoryPath } = require('../git/validation');

const STEP_TYPES = new Set(['stage_all', 'commit', 'fetch', 'pull', 'push', 'checkout', 'merge', 'guard', 'condition']);
const CONDITION_SOURCES = new Set(['commit_message', 'current_branch', 'start_branch']);
const CONDITION_OPERATORS = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with']);
const TEMPLATE_VARIABLES = new Set(['commitMessage', 'currentBranch', 'startBranch']);
const TRIGGER_EVENTS = new Set(['manual', 'after_commit']);
const MAX_MACROS = 100;
const MAX_STEPS = 100;
const MAX_NESTING = 5;

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'win32') fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function normalizeId(value, prefix) {
  if (value === undefined || value === null || value === '') return createId(prefix);
  const id = assertSingleLine(value, `${prefix} id`, { maxLength: 80 });
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${prefix} id contains unsupported characters`);
  return id;
}

function normalizeTemplate(value, label, { allowEmpty = false, maxLength = 4096 } = {}) {
  const template = assertSingleLine(value ?? '', label, { allowEmpty, maxLength }).trim();
  for (const match of template.matchAll(/\$\{([^}]+)\}/g)) {
    if (!TEMPLATE_VARIABLES.has(match[1])) throw new Error(`${label} contains an unsupported variable: ${match[1]}`);
  }
  if (template.replace(/\$\{[^}]+\}/g, '').includes('${')) throw new Error(`${label} contains an incomplete variable`);
  return template;
}

function normalizeCondition(input) {
  if (!input || typeof input !== 'object') throw new Error('Condition data is required');
  const source = CONDITION_SOURCES.has(input.source) ? input.source : 'commit_message';
  const operator = CONDITION_OPERATORS.has(input.operator) ? input.operator : 'contains';
  const value = assertSingleLine(input.value ?? '', 'Condition value', { maxLength: 1024 }).trim();
  if (!value) throw new Error('Condition value cannot be blank');
  return { source, operator, value, caseSensitive: input.caseSensitive === true };
}

function normalizeRemote(value, { allowEmpty = false } = {}) {
  const remote = assertSingleLine(value ?? '', 'Remote name', { allowEmpty, maxLength: 128 }).trim();
  return remote ? assertRemoteName(remote) : '';
}

function normalizeStep(input, state, depth = 0) {
  if (!input || typeof input !== 'object') throw new Error('Macro step data is required');
  if (depth > MAX_NESTING) throw new Error(`Macro blocks can be nested at most ${MAX_NESTING} levels deep`);
  state.count += 1;
  if (state.count > MAX_STEPS) throw new Error(`A macro can contain at most ${MAX_STEPS} blocks`);
  const type = STEP_TYPES.has(input.type) ? input.type : null;
  if (!type) throw new Error(`Unsupported macro block: ${input.type || 'unknown'}`);
  const step = { id: normalizeId(input.id, 'step'), type };

  if (type === 'commit') {
    step.messageSource = input.messageSource === 'template' ? 'template' : 'prompt';
    step.message = step.messageSource === 'template'
      ? normalizeTemplate(input.message ?? '', 'Commit message template', { maxLength: 10_000 })
      : '';
  } else if (type === 'fetch') {
    step.remote = normalizeRemote(input.remote, { allowEmpty: true });
    step.prune = input.prune !== false;
  } else if (type === 'pull') {
    step.remote = normalizeRemote(input.remote || 'origin');
    step.branch = normalizeTemplate(input.branch ?? '', 'Pull branch', { allowEmpty: true, maxLength: 1024 });
    step.rebase = input.rebase === true;
  } else if (type === 'push') {
    step.remote = normalizeRemote(input.remote || 'origin');
    step.branch = normalizeTemplate(input.branch ?? '', 'Push branch', { allowEmpty: true, maxLength: 1024 });
    step.setUpstream = input.setUpstream === true;
  } else if (type === 'checkout') {
    step.branch = normalizeTemplate(input.branch ?? '', 'Checkout branch', { maxLength: 1024 });
  } else if (type === 'merge') {
    step.branch = normalizeTemplate(input.branch ?? '', 'Merge branch', { maxLength: 1024 });
    step.noFf = input.noFf === true;
  } else if (type === 'guard') {
    step.condition = normalizeCondition(input.condition);
    step.message = assertSingleLine(input.message || 'Macro requirements are not met', 'Requirement message', { maxLength: 512 }).trim();
  } else if (type === 'condition') {
    step.condition = normalizeCondition(input.condition);
    const thenSteps = Array.isArray(input.thenSteps) ? input.thenSteps : [];
    const elseSteps = Array.isArray(input.elseSteps) ? input.elseSteps : [];
    step.thenSteps = thenSteps.map(child => normalizeStep(child, state, depth + 1));
    step.elseSteps = elseSteps.map(child => normalizeStep(child, state, depth + 1));
  }
  return step;
}

function containsStep(steps, type) {
  return steps.some(step => step.type === type
    || (step.type === 'condition' && (containsStep(step.thenSteps, type) || containsStep(step.elseSteps, type))));
}

function normalizeMacro(input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('Macro data is required');
  const now = new Date().toISOString();
  const name = assertSingleLine(input.name ?? '', 'Macro name', { maxLength: 80 }).trim();
  if (!name) throw new Error('Macro name cannot be blank');
  const description = assertSingleLine(input.description ?? '', 'Macro description', { allowEmpty: true, maxLength: 240 }).trim();
  const scope = input.scope === 'repository' ? 'repository' : 'global';
  const repositoryCandidate = input.repositoryPath || options.repositoryPath;
  const repositoryPath = scope === 'repository'
    ? normalizeRepositoryPath(repositoryCandidate, { mustExist: options.mustExist !== false })
    : '';
  const event = TRIGGER_EVENTS.has(input.trigger?.event) ? input.trigger.event : 'manual';
  const triggerCondition = event === 'after_commit' && input.trigger?.condition
    ? normalizeCondition(input.trigger.condition)
    : null;
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  if (rawSteps.length === 0) throw new Error('A macro must contain at least one block');
  const stepState = { count: 0 };
  const steps = rawSteps.map(step => normalizeStep(step, stepState));
  if (event === 'after_commit' && containsStep(steps, 'commit')) throw new Error('An after-commit hook cannot contain another commit block');
  return {
    id: normalizeId(input.id, 'macro'),
    name,
    description,
    enabled: input.enabled !== false,
    scope,
    repositoryPath,
    trigger: { event, condition: triggerCondition },
    steps,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now
  };
}

function conditionValue(condition, context) {
  if (condition.source === 'commit_message') return String(context.commitMessage || '');
  if (condition.source === 'start_branch') return String(context.startBranch || '');
  return String(context.currentBranch || '');
}

function evaluateCondition(condition, context) {
  const normalized = normalizeCondition(condition);
  let actual = conditionValue(normalized, context);
  let expected = normalized.value;
  if (!normalized.caseSensitive) {
    actual = actual.toLocaleLowerCase();
    expected = expected.toLocaleLowerCase();
  }
  if (normalized.operator === 'equals') return actual === expected;
  if (normalized.operator === 'not_equals') return actual !== expected;
  if (normalized.operator === 'contains') return actual.includes(expected);
  if (normalized.operator === 'not_contains') return !actual.includes(expected);
  if (normalized.operator === 'starts_with') return actual.startsWith(expected);
  return actual.endsWith(expected);
}

function createStarterMacro() {
  return normalizeMacro({
    id: 'develop_to_main',
    name: 'Develop → Main',
    description: 'Commit, publish develop, merge it into main, publish main and return to develop.',
    enabled: true,
    scope: 'global',
    trigger: { event: 'manual' },
    steps: [
      { type: 'guard', condition: { source: 'current_branch', operator: 'equals', value: 'develop' }, message: 'Run this macro from the develop branch.' },
      { type: 'stage_all' },
      { type: 'commit', messageSource: 'prompt' },
      { type: 'push', remote: 'origin', branch: 'develop' },
      { type: 'checkout', branch: 'main' },
      { type: 'pull', remote: 'origin', branch: 'main' },
      { type: 'merge', branch: 'develop' },
      { type: 'push', remote: 'origin', branch: 'main' },
      { type: 'checkout', branch: 'develop' }
    ]
  }, { mustExist: false });
}

function sameRepository(left, right) {
  const normalize = value => path.resolve(String(value || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normalize(left).toLocaleLowerCase() === normalize(right).toLocaleLowerCase()
    : normalize(left) === normalize(right);
}

class MacroManager {
  constructor({ userDataPath }) {
    this.filePath = path.join(path.resolve(userDataPath), 'automations.json');
    this._macros = this._read();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed.macros)) return [createStarterMacro()];
      const macros = [];
      for (const item of parsed.macros.slice(0, MAX_MACROS)) {
        try { macros.push(normalizeMacro(item, { mustExist: false })); } catch { /* ignore invalid persisted entries */ }
      }
      return macros;
    } catch {
      return [createStarterMacro()];
    }
  }

  _save() {
    atomicWriteJson(this.filePath, { version: 1, macros: this._macros });
  }

  list(repositoryPath) {
    return this._macros
      .filter(macro => macro.scope === 'global' || (repositoryPath && sameRepository(macro.repositoryPath, repositoryPath)))
      .map(clone);
  }

  get(id, repositoryPath) {
    const safeId = normalizeId(id, 'macro');
    const macro = this.list(repositoryPath).find(item => item.id === safeId);
    if (!macro) throw new Error(`Macro does not exist or is not available for this repository: ${safeId}`);
    return macro;
  }

  save(input, repositoryPath) {
    const macro = normalizeMacro(input, { repositoryPath });
    const index = this._macros.findIndex(item => item.id === macro.id);
    if (index >= 0) {
      macro.createdAt = this._macros[index].createdAt;
      this._macros[index] = macro;
    } else {
      if (this._macros.length >= MAX_MACROS) throw new Error(`At most ${MAX_MACROS} macros can be stored`);
      this._macros.push(macro);
    }
    this._save();
    return clone(macro);
  }

  remove(id, repositoryPath) {
    const macro = this.get(id, repositoryPath);
    this._macros = this._macros.filter(item => item.id !== macro.id);
    this._save();
    return this.list(repositoryPath);
  }

  matching(event, context, repositoryPath) {
    if (!TRIGGER_EVENTS.has(event) || event === 'manual') return [];
    return this.list(repositoryPath).filter(macro => macro.enabled
      && macro.trigger.event === event
      && (!macro.trigger.condition || evaluateCondition(macro.trigger.condition, context)));
  }
}

module.exports = { MacroManager, createStarterMacro, evaluateCondition, normalizeCondition, normalizeMacro, normalizeTemplate };
