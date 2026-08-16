const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { KitsuneDraftManager } = require('../src/integrations/kitsune-draft-manager');

test('offline drafts are encrypted locally and reconcile with server versions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-drafts-')); const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().slice(10) };
  const published = []; const serverManager = { syncDrafts: async input => ({ cursor: 4, accepted: input.changes.map((item, index) => ({ ...item, id: `${String(index + 1).padStart(8, '0')}-1111-1111-1111-111111111111`, version: 1 })), changes: [], conflicts: [] }), publishDraft: async id => { published.push(id); return { id: 'published' }; } };
  try {
    const manager = new KitsuneDraftManager({ userDataPath: root, safeStorage, serverManager }); const item = manager.save({ projectId: '11111111-1111-1111-1111-111111111111', type: 'issue', payload: { title: 'Offline' } }); assert.equal(manager.list().length, 1);
    const raw = fs.readFileSync(path.join(root, 'kitsune-drafts.bin'), 'utf8'); assert.equal(raw.includes('Offline'), true); assert.ok(raw.startsWith('encrypted:'));
    const result = await manager.sync(); assert.equal(result.drafts[0].version, 1); await manager.publish(item.clientId); assert.equal(published.length, 1); assert.equal(manager.list().length, 0);
    const conflictDraft = manager.save({ projectId: '11111111-1111-1111-1111-111111111111', type: 'review', payload: { body: 'Local' } }); manager.resolveConflict(conflictDraft.clientId, 'server', { id: '22222222-2222-2222-2222-222222222222', clientId: conflictDraft.clientId, projectId: conflictDraft.projectId, type: 'review', payload: { body: 'Remote' }, version: 3, deleted: false, updatedAt: new Date().toISOString() }); assert.equal(manager.list()[0].payload.body, 'Remote'); manager.remove(conflictDraft.clientId); assert.equal(manager.list().length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
