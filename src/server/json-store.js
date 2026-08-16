const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = this._read();
  }

  _read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.projects)) throw new Error('Unsupported data format');
      return { issues: [], mergeRequests: [], mergeQueueEntries: [], qualityGateProviders: [], qualityGateStatuses: [], previewEnvironments: [], aiPolicies: [], aiRuns: [], collaborationEvents: [], collaborationSequence: 0, forgeRemotes: [], serviceDependencies: [], policyEvidenceBundles: [], attentionStates: [], changeBundles: [], changeBundleImports: [], drafts: [], draftSequence: 0, audit: [], users: [], sessions: [], invitations: [], passwordResets: [], authChallenges: [], passkeys: [], memberships: [], groups: [], groupMemberships: [], projectRulesets: [], mirrorConflicts: [], mirrorUserMappings: [], reviewThreads: [], sshKeys: [], packages: [], containerBlobs: [], containerManifests: [], boards: [], notifications: [], releases: [], wikiPages: [], snippets: [], milestones: [], webhooks: [], webhookDeliveries: [], ...value };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, projects: [], issues: [], mergeRequests: [], mergeQueueEntries: [], qualityGateProviders: [], qualityGateStatuses: [], previewEnvironments: [], aiPolicies: [], aiRuns: [], collaborationEvents: [], collaborationSequence: 0, forgeRemotes: [], serviceDependencies: [], policyEvidenceBundles: [], attentionStates: [], changeBundles: [], changeBundleImports: [], drafts: [], draftSequence: 0, audit: [], users: [], sessions: [], invitations: [], passwordResets: [], authChallenges: [], passkeys: [], memberships: [], groups: [], groupMemberships: [], projectRulesets: [], mirrorConflicts: [], mirrorUserMappings: [], reviewThreads: [], sshKeys: [], packages: [], containerBlobs: [], containerManifests: [], boards: [], notifications: [], releases: [], wikiPages: [], snippets: [], milestones: [], webhooks: [], webhookDeliveries: [] };
    }
  }

  snapshot() { return clone(this.state); }

  update(mutator, audit) {
    const draft = clone(this.state);
    const result = mutator(draft);
    if (audit) {
      draft.audit.push({ id: crypto.randomUUID(), at: new Date().toISOString(), ...audit });
      draft.audit = draft.audit.slice(-10_000);
    }
    this._write(draft);
    this.state = draft;
    return clone(result);
  }

  acquireLease() { return true; }

  _write(value) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform === 'win32') fs.rmSync(this.filePath, { force: true });
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = { JsonStore };
