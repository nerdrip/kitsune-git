const fs = require('node:fs');
const path = require('node:path');

const CONTROL_CHARACTERS = /[\0\r\n]/;
const INVALID_REF_CHARACTERS = /[\x00-\x20\x7f~^:?*[\\]/;
const BLOCKED_GIT_ENVIRONMENT_KEYS = new Set([
  'EDITOR',
  'VISUAL',
  'PAGER',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_SHALLOW_FILE',
  'GIT_NAMESPACE',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PAGER',
  'GIT_CONFIG',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS'
]);

function sanitizeGitEnvironment(input = process.env, { trustedRuntime = false } = {}) {
  const environment = input && typeof input === 'object' ? { ...input } : {};
  for (const name of Object.keys(environment)) {
    if (
      BLOCKED_GIT_ENVIRONMENT_KEYS.has(name)
      || name.startsWith('GIT_CONFIG_KEY_')
      || name.startsWith('GIT_CONFIG_VALUE_')
      || name === 'GIT_CONFIG_COUNT'
      || name.startsWith('GIT_AUTHOR_')
      || name.startsWith('GIT_COMMITTER_')
    ) {
      delete environment[name];
    }
  }
  if (!trustedRuntime) {
    delete environment.GIT_EXEC_PATH;
    delete environment.GIT_TEMPLATE_DIR;
    delete environment.GIT_SSH;
    delete environment.GIT_SSH_COMMAND;
    delete environment.GIT_SSH_VARIANT;
  }
  return environment;
}

function assertString(value, label, { allowEmpty = false, maxLength = 4096 } = {}) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new Error(`${label} must contain between ${allowEmpty ? 0 : 1} and ${maxLength} characters`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} contains an invalid null character`);
  }
  return value;
}

function normalizeRepositoryPath(repoPath, { mustExist = true } = {}) {
  assertString(repoPath, 'Repository path');
  const resolved = path.resolve(repoPath);
  if (mustExist) {
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Repository directory does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Repository path is not a directory: ${resolved}`);
    }
  }
  return resolved;
}

function canonicalizeFileSystemPath(filePath) {
  assertString(filePath, 'Path');
  const resolved = path.resolve(filePath);
  try {
    return typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    // Paths retained by `git worktree prune` may no longer exist.
    return resolved;
  }
}

function pathsEqual(first, second) {
  const left = canonicalizeFileSystemPath(first);
  const right = canonicalizeFileSystemPath(second);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function normalizeRelativePath(repoPath, filePath, label = 'File path') {
  assertString(filePath, label);
  if (CONTROL_CHARACTERS.test(filePath) || path.isAbsolute(filePath) || /^[A-Za-z]:/.test(filePath)) {
    throw new Error(`${label} must be a repository-relative path`);
  }

  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} points outside the repository`);
  }

  const repository = normalizeRepositoryPath(repoPath);
  const resolved = path.resolve(repository, ...normalized.split('/'));
  const relative = path.relative(repository, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} points outside the repository`);
  }
  return normalized;
}

function normalizePathList(repoPath, files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 10_000) {
    throw new Error('Files must be a non-empty array containing at most 10,000 paths');
  }
  return [...new Set(files.map(file => normalizeRelativePath(repoPath, file)))];
}

function literalPathspec(repoPath, filePath) {
  return `:(literal)${normalizeRelativePath(repoPath, filePath)}`;
}

function literalPathspecs(repoPath, files) {
  return normalizePathList(repoPath, files).map(file => `:(literal)${file}`);
}

function assertRefName(value, label = 'Git reference') {
  assertString(value, label, { maxLength: 1024 });
  if (
    value !== value.trim()
    || value.startsWith('-')
    || value.startsWith('.')
    || value.endsWith('.')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || value.split('/').some(part => !part || part.endsWith('.lock') || part.startsWith('.'))
    || INVALID_REF_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} is not a valid Git reference`);
  }
  return value;
}

function assertRevision(value, label = 'Commit hash') {
  assertString(value, label, { maxLength: 64 });
  if (!/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new Error(`${label} must be a 7-64 character hexadecimal hash`);
  }
  return value;
}

function assertRemoteName(value) {
  assertString(value, 'Remote name', { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.startsWith('-')) {
    throw new Error('Remote name contains invalid characters');
  }
  return value;
}

function assertRemoteUrl(value) {
  assertString(value, 'Repository URL', { maxLength: 4096 });
  if (value !== value.trim() || value.startsWith('-') || CONTROL_CHARACTERS.test(value)) {
    throw new Error('Repository URL is invalid');
  }
  return value;
}

function assertStashIndex(value) {
  const index = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(index) || index < 0 || index > 100_000) {
    throw new Error('Stash index must be a non-negative integer');
  }
  return index;
}

function normalizeMaxCount(value, fallback = 200, maximum = 1000) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Commit count must be a positive integer');
  }
  return Math.min(value, maximum);
}

function assertMessage(value, label, { allowEmpty = false, maxLength = 100_000 } = {}) {
  assertString(value, label, { allowEmpty, maxLength });
  if (value.includes('\0')) throw new Error(`${label} contains an invalid null character`);
  if (!allowEmpty && !value.trim()) throw new Error(`${label} cannot be blank`);
  return value;
}

function assertSingleLine(value, label, { allowEmpty = false, maxLength = 4096 } = {}) {
  assertString(value, label, { allowEmpty, maxLength });
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${label} must be a single line`);
  return value;
}

module.exports = {
  assertMessage,
  assertRefName,
  assertRemoteName,
  assertRemoteUrl,
  assertRevision,
  assertSingleLine,
  assertStashIndex,
  canonicalizeFileSystemPath,
  literalPathspec,
  literalPathspecs,
  normalizeMaxCount,
  normalizePathList,
  normalizeRelativePath,
  normalizeRepositoryPath,
  pathsEqual,
  sanitizeGitEnvironment
};
