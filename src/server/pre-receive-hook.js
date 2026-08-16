#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const levels = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 };
function globRegex(pattern) { let value = String(pattern || '').trim(); const anchored = value.startsWith('/'); if (anchored) value = value.slice(1); const directory = value.endsWith('/'); if (directory) value = value.slice(0, -1); let source = ''; for (let index = 0; index < value.length; index += 1) { const character = value[index]; if (character === '*' && value[index + 1] === '*') { source += '.*'; index += 1; } else if (character === '*') source += '[^/]*'; else if (character === '?') source += '[^/]'; else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'); } if (!anchored && !value.includes('/')) source = `(?:^|.*/)${source}`; else source = `^${source}`; return new RegExp(`${source}${directory ? '(?:/.*)?' : ''}$`); }
function bytes(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) if (!entry.isSymbolicLink()) total += bytes(path.join(target, entry.name));
  return total;
}
function readState(file) {
  if (!file.endsWith('.sqlite')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(database.prepare('SELECT value FROM kitsune_state WHERE id = 1').get().value); }
  finally { database.close(); }
}
try {
  const administrator = process.env.KITSUNE_ACTOR_ADMIN === '1';
  const state = readState(process.env.KITSUNE_DATA_FILE);
  const projectId = process.env.KITSUNE_PROJECT_ID;
  const project = state.projects.find(item => item.id === projectId);
  if (!project) throw new Error('Project metadata is missing');
  const active = item => item && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now());
  const membership = state.memberships.find(item => item.projectId === projectId && item.userId === process.env.KITSUNE_ACTOR_ID && active(item));
  let actorLevel = levels[membership?.role] || 0;
  let group = project.groupId ? state.groups.find(item => item.id === project.groupId) : null;
  const seen = new Set();
  while (group && !seen.has(group.id)) {
    seen.add(group.id);
    const inherited = state.groupMemberships.find(item => item.groupId === group.id && item.userId === process.env.KITSUNE_ACTOR_ID && active(item));
    actorLevel = Math.max(actorLevel, levels[inherited?.role] || 0);
    group = group.parentId ? state.groups.find(item => item.id === group.parentId) : null;
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 1024 * 1024) throw new Error('Too many reference updates'); });
  process.stdin.on('end', () => {
    const storageLimit = Number(project.storageLimitBytes || process.env.KITSUNE_DEFAULT_STORAGE_LIMIT_BYTES || 0);
    if (storageLimit > 0) {
      const dataRoot = path.dirname(process.env.KITSUNE_DATA_FILE);
      const registryBytes = (state.containerBlobs || []).filter(item => item.projectId === projectId).reduce((total, item) => total + Number(item.size || 0), 0);
      const used = bytes(process.cwd()) + bytes(path.join(dataRoot, 'lfs', projectId)) + bytes(path.join(dataRoot, 'packages', projectId)) + bytes(path.join(dataRoot, 'registry', 'manifests', projectId)) + registryBytes;
      if (used > storageLimit) { process.stderr.write(`Project storage quota exceeded (${used}/${storageLimit} bytes)\n`); process.exitCode = 1; return; }
    }
    if (administrator) return;
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const ref = line.trim().split(/\s+/)[2] || '';
      if (ref.startsWith('refs/kitsune/')) { process.stderr.write('refs/kitsune is managed by the collaboration service\n'); process.exitCode = 1; return; }
      if (!ref.startsWith('refs/heads/')) continue;
      const branch = ref.slice('refs/heads/'.length);
      const rule = (project.protectedBranches || []).find(item => item.branch === branch);
      if (rule && actorLevel < (levels[rule.pushRole] || levels.maintainer)) {
        process.stderr.write(`Protected branch ${branch} requires ${rule.pushRole || 'maintainer'} role\n`);
        process.exitCode = 1;
        return;
      }
      const workflowRule = (state.projectRulesets || []).find(item => item.projectId === projectId && item.enforcement === 'active' && globRegex(item.branchPattern || '*').test(branch) && (item.requireMergeQueue || item.requiredApprovals > 0 || item.requireCodeOwners || item.requiredReviewers?.length || item.requiredQualityGates?.length));
      if (workflowRule) {
        process.stderr.write(`Branch ${branch} is governed by ruleset ${workflowRule.name}; update it through the merge workflow\n`);
        process.exitCode = 1;
        return;
      }
    }
  });
} catch (error) {
  process.stderr.write(`KitsuneGIT policy check failed: ${error.message}\n`);
  process.exitCode = 1;
}
