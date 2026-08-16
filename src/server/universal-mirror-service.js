const crypto = require('node:crypto');

function comparable(item) { return JSON.stringify({ title: item.title, description: item.description || '', state: item.state, labels: item.labels || [], sourceBranch: item.sourceBranch, targetBranch: item.targetBranch, draft: Boolean(item.draft) }); }

class UniversalMirrorService {
  constructor({ store, projects, providerImports }) { this.store = store; this.projects = projects; this.providerImports = providerImports; this.running = new Map(); }
  _raw(id) { const project = this.store.snapshot().projects.find(item => item.id === id); if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 }); return project; }
  _authentication(project) { const token = project.mirrorCredential ? this.projects.secretVault?.decrypt(project.mirrorCredential) : null; return token ? { token, username: project.sourceProvider === 'github' ? 'x-access-token' : 'oauth2' } : null; }
  async sync(id, actor = 'mirror') { if (this.running.has(id)) return this.running.get(id); const operation = this._sync(id, actor).finally(() => this.running.delete(id)); this.running.set(id, operation); return operation; }
  async _sync(id, actor) {
    const project = this._raw(id); if (!project.mirror || !project.sourceUrl) throw new Error('Project is not configured as a mirror'); const direction = project.mirrorDirection || 'pull'; const authentication = this._authentication(project); const baseline = project.lastMetadataMirrorAt || project.createdAt;
    const refResult = direction === 'bidirectional' ? await this._syncBidirectionalRefs(project, authentication, actor) : direction === 'push' ? await this.projects.repositories.pushMirror(project, authentication) : await this.projects.sync(id, actor);
    let metadata = null; if (project.metadataMirror && ['github', 'gitlab'].includes(project.sourceProvider)) metadata = await this._syncMetadata(project, authentication?.token || null, direction, baseline, actor);
    const now = new Date().toISOString(); const saved = this.store.update(state => { const current = state.projects.find(item => item.id === id); current.lastMirrorAt = now; current.lastMetadataMirrorAt = metadata ? now : current.lastMetadataMirrorAt; current.mirrorError = null; if (refResult?.defaultBranch) current.defaultBranch = refResult.defaultBranch; return current; }, { actor, action: 'universal-mirror.sync', target: id });
    return { project: this.projects._public(saved), refs: refResult, metadata, conflicts: this.conflicts(id) };
  }
  async _syncBidirectionalRefs(project, authentication, actor) {
    const [local, remote] = await Promise.all([this.projects.repositories.refMap(project), this.projects.repositories.remoteRefMap(project, authentication)]); const baseline = project.mirrorRefSnapshot || {}; const conflicts = []; const changes = [];
    for (const ref of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseline)])) {
      const before = baseline[ref] || null; const here = local[ref] || null; const there = remote[ref] || null; if (here === there) continue; const localChanged = here !== before; const remoteChanged = there !== before;
      if (localChanged && remoteChanged) { conflicts.push(this._conflict(project.id, 'git-ref', ref, here, there, actor)); continue; }
      if (remoteChanged) { if (there) await this.projects.repositories.fetchRef(project, ref, authentication); else await this.projects.repositories.deleteLocalRef(project, ref); changes.push({ ref, direction: 'pull', hash: there }); }
      else { await this.projects.repositories.pushRef(project, ref, !here, authentication, true); changes.push({ ref, direction: 'push', hash: here }); }
    }
    const [nextLocal, nextRemote] = await Promise.all([this.projects.repositories.refMap(project), this.projects.repositories.remoteRefMap(project, authentication)]); const snapshot = {}; for (const ref of new Set([...Object.keys(nextLocal), ...Object.keys(nextRemote)])) if (nextLocal[ref] === nextRemote[ref]) snapshot[ref] = nextLocal[ref];
    this.store.update(state => { const current = state.projects.find(item => item.id === project.id); current.mirrorRefSnapshot = snapshot; return null; }); return { direction: 'bidirectional', changes, conflicts: conflicts.length, refs: snapshot };
  }
  _conflict(projectId, type, key, local, remote, actor) { const existing = this.store.snapshot().mirrorConflicts.find(item => item.projectId === projectId && item.type === type && item.key === key && item.state === 'open'); if (existing) return existing; const item = { id: crypto.randomUUID(), projectId, type, key, local, remote, state: 'open', detectedAt: new Date().toISOString() }; this.store.update(state => { state.mirrorConflicts.push(item); return null; }, { actor, action: 'mirror.conflict', target: item.id }); return item; }
  async _syncMetadata(project, token, direction, baseline, actor) {
    let pulled = 0; let pushed = 0; let conflicts = 0; const providerData = direction !== 'push' ? await this.providerImports.inspect({ provider: project.sourceProvider, sourceUrl: project.sourceUrl, token }) : null;
    if (providerData) for (const [collection, remoteItems] of [['issues', providerData.issues], ['mergeRequests', providerData.mergeRequests]]) for (const remote of remoteItems) {
      const current = this.store.snapshot()[collection].find(item => item.projectId === project.id && item.external?.provider === project.sourceProvider && item.external?.id === remote.external.id); if (!current) { this.store.update(state => { state[collection].push({ id: crypto.randomUUID(), projectId: project.id, ...remote }); return null; }); pulled += 1; continue; }
      const localChanged = Date.parse(current.updatedAt || 0) > Date.parse(baseline || 0); const remoteChanged = Date.parse(remote.external.updatedAt || 0) > Date.parse(baseline || 0); if (localChanged && remoteChanged && comparable(current) !== comparable(remote)) { this._conflict(project.id, collection === 'issues' ? 'issue' : 'merge-request', current.id, comparable(current), comparable(remote), actor); conflicts += 1; continue; }
      if (remoteChanged) { this.store.update(state => { const item = state[collection].find(value => value.id === current.id); Object.assign(item, remote, { id: current.id, projectId: project.id, iid: current.iid }); return null; }); pulled += 1; }
    }
    if (direction !== 'pull' && token) for (const [collection, type] of [['issues', 'issue'], ['mergeRequests', 'merge-request']]) for (const item of this.store.snapshot()[collection].filter(value => value.projectId === project.id && (!value.external || Date.parse(value.updatedAt || value.createdAt) > Date.parse(baseline || 0)))) {
      if (this.store.snapshot().mirrorConflicts.some(value => value.projectId === project.id && value.key === item.id && value.state === 'open')) continue; const external = await this.providerImports.writeWorkItem({ provider: project.sourceProvider, sourceUrl: project.sourceUrl, token, type, item }); this.store.update(state => { state[collection].find(value => value.id === item.id).external = external; return null; }); pushed += 1;
    }
    return { pulled, pushed, conflicts };
  }
  conflicts(projectId) { return this.store.snapshot().mirrorConflicts.filter(item => item.projectId === projectId); }
  async resolveConflict(projectId, conflictId, resolution, actor) {
    if (!['local', 'remote', 'manual'].includes(resolution)) throw new Error('Conflict resolution is invalid');
    const conflict = this.store.snapshot().mirrorConflicts.find(value => value.id === conflictId && value.projectId === projectId);
    if (!conflict) throw Object.assign(new Error('Mirror conflict not found'), { statusCode: 404 });
    if (conflict.state !== 'open') throw Object.assign(new Error('Mirror conflict is already resolved'), { statusCode: 409 });
    const project = this._raw(projectId); const authentication = this._authentication(project);
    if (conflict.type === 'git-ref' && resolution !== 'manual') {
      if (resolution === 'local') await this.projects.repositories.pushRef(project, conflict.key, !conflict.local, authentication, true);
      else if (conflict.remote) await this.projects.repositories.fetchRef(project, conflict.key, authentication);
      else await this.projects.repositories.deleteLocalRef(project, conflict.key);
      this.store.update(state => { const current = state.projects.find(item => item.id === projectId); current.mirrorRefSnapshot ||= {}; const selected = resolution === 'local' ? conflict.local : conflict.remote; if (selected) current.mirrorRefSnapshot[conflict.key] = selected; else delete current.mirrorRefSnapshot[conflict.key]; return null; });
    }
    if (['issue', 'merge-request'].includes(conflict.type) && resolution !== 'manual') {
      const collection = conflict.type === 'issue' ? 'issues' : 'mergeRequests'; const current = this.store.snapshot()[collection].find(item => item.id === conflict.key);
      if (!current) throw Object.assign(new Error('Mirrored work item is missing'), { statusCode: 409 });
      if (resolution === 'remote') { const remote = JSON.parse(conflict.remote); this.store.update(state => { Object.assign(state[collection].find(item => item.id === conflict.key), remote, { id: current.id, projectId, iid: current.iid }); return null; }); }
      else { if (!authentication?.token) throw Object.assign(new Error('Mirror credentials are required to publish local metadata'), { statusCode: 409 }); const external = await this.providerImports.writeWorkItem({ provider: project.sourceProvider, sourceUrl: project.sourceUrl, token: authentication.token, type: conflict.type, item: current }); this.store.update(state => { state[collection].find(item => item.id === conflict.key).external = external; return null; }); }
    }
    return this.store.update(state => { const item = state.mirrorConflicts.find(value => value.id === conflictId && value.projectId === projectId); item.state = 'resolved'; item.resolution = resolution; item.resolvedBy = actor; item.resolvedAt = new Date().toISOString(); return item; }, { actor, action: 'mirror.conflict.resolve', target: conflictId });
  }
  exportManifest(projectId) { const project = this.projects.get(projectId); const state = this.store.snapshot(); const select = name => state[name].filter(item => item.projectId === projectId); return { format: 'kitsune-project-export', version: 1, exportedAt: new Date().toISOString(), project: { ...project, mirrorCredential: undefined }, issues: select('issues'), mergeRequests: select('mergeRequests'), reviewThreads: select('reviewThreads'), releases: select('releases'), wikiPages: select('wikiPages'), snippets: select('snippets'), milestones: select('milestones'), boards: select('boards'), rulesets: select('projectRulesets'), memberships: select('memberships') }; }
}

module.exports = { UniversalMirrorService, comparable };
