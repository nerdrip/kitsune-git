const fs = require('node:fs');
const path = require('node:path');

function directoryBytes(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false }); if (!stat) return 0; if (stat.isFile()) return stat.size; if (!stat.isDirectory()) return 0;
  let total = 0; for (const entry of fs.readdirSync(target, { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; total += directoryBytes(path.join(target, entry.name)); } return total;
}

class StorageQuotaService {
  constructor({ dataPath, projects, defaultLimitBytes = 0 }) { this.dataPath = path.resolve(dataPath); this.projects = projects; this.defaultLimitBytes = defaultLimitBytes; }
  usage(projectId) {
    const project = this.projects.get(projectId);
    const repository = directoryBytes(this.projects.repositories.pathFor(project));
    const lfs = directoryBytes(path.join(this.dataPath, 'lfs', project.id));
    const packages = directoryBytes(path.join(this.dataPath, 'packages', project.id));
    const manifests = directoryBytes(path.join(this.dataPath, 'registry', 'manifests', project.id));
    const blobs = this.projects.store.snapshot().containerBlobs.filter(item => item.projectId === project.id).reduce((total, item) => total + Number(item.size || 0), 0);
    const usedBytes = repository + lfs + packages + manifests + blobs;
    const limitBytes = Number(project.storageLimitBytes ?? this.defaultLimitBytes) || 0;
    return { projectId, usedBytes, limitBytes, remainingBytes: limitBytes ? Math.max(0, limitBytes - usedBytes) : null, breakdown: { repository, lfs, packages, containerRegistry: manifests + blobs } };
  }
  assert(projectId, additionalBytes = 0) { const usage = this.usage(projectId); if (usage.limitBytes && usage.usedBytes + Math.max(0, Number(additionalBytes) || 0) > usage.limitBytes) throw Object.assign(new Error('Project storage quota exceeded'), { statusCode: 413 }); return usage; }
}

module.exports = { StorageQuotaService, directoryBytes };
