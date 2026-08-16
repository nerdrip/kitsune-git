const crypto = require('node:crypto');

class DraftService {
  constructor({ store, auth, workItems }) { this.store = store; this.auth = auth; this.workItems = workItems; }
  _validate(change) { if (!/^[0-9a-f-]{36}$/.test(String(change.clientId || ''))) throw new Error('Draft client ID is invalid'); if (!['issue', 'merge-request', 'review'].includes(change.type)) throw new Error('Draft type is invalid'); const payload = change.payload && typeof change.payload === 'object' && !Array.isArray(change.payload) ? change.payload : {}; if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024) throw Object.assign(new Error('Draft exceeds 1 MiB'), { statusCode: 413 }); return payload; }
  sync(input, actor) {
    const changes = Array.isArray(input.changes) ? input.changes.slice(0, 500) : []; const cursor = Math.max(0, Number(input.cursor) || 0); const conflicts = [];
    const accepted = this.store.update(state => {
      const output = [];
      for (const change of changes) {
        const payload = this._validate(change); this.auth.requireProject(change.projectId, actor, 'developer'); const existing = state.drafts.find(item => item.userId === actor.id && item.clientId === change.clientId);
        if (existing && Number(change.version || 0) !== existing.version) { conflicts.push({ clientId: change.clientId, local: change, server: existing }); continue; }
        state.draftSequence = Number(state.draftSequence || 0) + 1; const item = existing || { id: crypto.randomUUID(), clientId: change.clientId, userId: actor.id, projectId: change.projectId, type: change.type, createdAt: new Date().toISOString() }; item.payload = payload; item.deleted = Boolean(change.deleted); item.version = (existing?.version || 0) + 1; item.sequence = state.draftSequence; item.updatedAt = new Date().toISOString(); if (!existing) state.drafts.push(item); output.push(item);
      }
      return output;
    }, changes.length ? { actor: actor.username, action: 'draft.sync', target: actor.id } : null);
    const state = this.store.snapshot(); return { cursor: Number(state.draftSequence || 0), accepted, changes: state.drafts.filter(item => item.userId === actor.id && item.sequence > cursor), conflicts };
  }
  publish(id, actor) { const draft = this.store.snapshot().drafts.find(item => item.id === id && item.userId === actor.id && !item.deleted); if (!draft) throw Object.assign(new Error('Draft not found'), { statusCode: 404 }); this.auth.requireProject(draft.projectId, actor, 'developer'); let published; if (draft.type === 'issue') published = this.workItems.createIssue(draft.projectId, draft.payload, actor.username); else if (draft.type === 'merge-request') published = this.workItems.createMergeRequest(draft.projectId, draft.payload, actor.username); else { const iid = Number(draft.payload.mergeRequestIid); published = this.workItems.createReviewThread(draft.projectId, iid, draft.payload, actor.username); } this.store.update(state => { const item = state.drafts.find(value => value.id === id); item.deleted = true; item.publishedAt = new Date().toISOString(); item.publishedId = published.id; state.draftSequence += 1; item.sequence = state.draftSequence; item.version += 1; return null; }, { actor: actor.username, action: 'draft.publish', target: id }); return published; }
}

module.exports = { DraftService };
