const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function initialState() { return { version: 1, projects: [], issues: [], mergeRequests: [], mergeQueueEntries: [], qualityGateProviders: [], qualityGateStatuses: [], previewEnvironments: [], aiPolicies: [], aiRuns: [], collaborationEvents: [], collaborationSequence: 0, forgeRemotes: [], serviceDependencies: [], policyEvidenceBundles: [], attentionStates: [], changeBundles: [], changeBundleImports: [], drafts: [], draftSequence: 0, audit: [], users: [], sessions: [], invitations: [], passwordResets: [], authChallenges: [], passkeys: [], memberships: [], groups: [], groupMemberships: [], projectRulesets: [], mirrorConflicts: [], mirrorUserMappings: [], reviewThreads: [], sshKeys: [], packages: [], containerBlobs: [], containerManifests: [], boards: [], notifications: [], releases: [], wikiPages: [], snippets: [], milestones: [], webhooks: [], webhookDeliveries: [] }; }

class SqliteStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath); fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath); this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kitsune_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS kitsune_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);');
    this.database.prepare('INSERT OR IGNORE INTO kitsune_state (id, value, revision) VALUES (1, ?, 0)').run(JSON.stringify(initialState()));
  }
  _read() { const value = JSON.parse(this.database.prepare('SELECT value FROM kitsune_state WHERE id = 1').get().value); if (value.version !== 1 || !Array.isArray(value.projects)) throw new Error('Unsupported data format'); return { ...initialState(), ...value }; }
  snapshot() { return clone(this._read()); }
  update(mutator, audit) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const draft = this._read(); const result = mutator(draft);
      if (audit) { draft.audit.push({ id: crypto.randomUUID(), at: new Date().toISOString(), ...audit }); draft.audit = draft.audit.slice(-10_000); }
      this.database.prepare('UPDATE kitsune_state SET value = ?, revision = revision + 1 WHERE id = 1').run(JSON.stringify(draft)); this.database.exec('COMMIT'); return clone(result);
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  acquireLease(name, owner, ttlMilliseconds, now = Date.now()) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM kitsune_leases WHERE expires_at <= ?').run(now);
      const current = this.database.prepare('SELECT owner FROM kitsune_leases WHERE name = ?').get(name);
      if (current && current.owner !== owner) { this.database.exec('COMMIT'); return false; }
      this.database.prepare('INSERT INTO kitsune_leases (name, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at').run(name, owner, now + ttlMilliseconds);
      this.database.exec('COMMIT'); return true;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  close() { this.database.close(); }
}

module.exports = { SqliteStore, initialState };
