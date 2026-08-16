const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { slug } = require('./validation');

function packagePart(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(normalized) || normalized === '.' || normalized === '..') throw new Error(`${label} is invalid`);
  return normalized;
}

class PackageService {
  constructor({ dataPath, store, projects, quota = null, maxBytes = 1024 * 1024 * 1024 }) {
    this.root = path.resolve(dataPath, 'packages'); this.store = store; this.projects = projects; this.quota = quota; this.maxBytes = maxBytes;
  }

  list(projectId) { this.projects.get(projectId); return this.store.snapshot().packages.filter(item => item.projectId === projectId); }

  async upload(request, projectId, input, actor) {
    this.projects.get(projectId);
    const name = slug(input.name, 'Package name');
    const version = packagePart(input.version, 'Package version');
    const fileName = packagePart(input.fileName, 'Package file name');
    const existing = this.store.snapshot().packages.find(item => item.projectId === projectId && item.name === name && item.version === version && item.fileName === fileName);
    if (existing) throw Object.assign(new Error('Package file already exists'), { statusCode: 409 });
    const directory = path.join(this.root, projectId, name, version);
    const target = path.join(directory, fileName);
    const temporary = `${target}.${crypto.randomUUID()}.upload`;
    this.quota?.assert(projectId, Number(request.headers['content-length']) || 0);
    fs.mkdirSync(directory, { recursive: true });
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
        request.on('data', chunk => { size += chunk.length; hash.update(chunk); if (size > this.maxBytes) request.destroy(Object.assign(new Error('Package exceeds the configured size limit'), { statusCode: 413 })); });
        request.once('error', reject); output.once('error', reject); output.once('finish', resolve); request.pipe(output);
      });
      const digest = hash.digest('hex');
      this.quota?.assert(projectId, 0);
      const expected = String(input.sha256 || '').toLowerCase();
      if (expected && (!/^[a-f0-9]{64}$/.test(expected) || expected !== digest)) throw Object.assign(new Error('Package SHA-256 does not match'), { statusCode: 422 });
      fs.renameSync(temporary, target);
      const item = { id: crypto.randomUUID(), projectId, type: 'generic', name, version, fileName, size, sha256: digest, author: actor, createdAt: new Date().toISOString() };
      return this.store.update(state => { state.packages.push(item); return item; }, { actor, action: 'package.upload', target: item.id });
    } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }

  download(response, projectId, input) {
    const item = this.store.snapshot().packages.find(candidate => candidate.projectId === projectId && candidate.name === input.name && candidate.version === input.version && candidate.fileName === input.fileName);
    if (!item) throw Object.assign(new Error('Package not found'), { statusCode: 404 });
    const target = path.join(this.root, projectId, item.name, item.version, item.fileName);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.size, 'Docker-Content-Digest': `sha256:${item.sha256}`, 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(target).pipe(response);
  }

  remove(projectId, packageId, actor) {
    return this.store.update(state => {
      const index = state.packages.findIndex(item => item.id === packageId && item.projectId === projectId);
      if (index < 0) throw Object.assign(new Error('Package not found'), { statusCode: 404 });
      const item = state.packages.splice(index, 1)[0];
      fs.rmSync(path.join(this.root, projectId, item.name, item.version, item.fileName), { force: true });
      return item;
    }, { actor, action: 'package.remove', target: packageId });
  }
}

module.exports = { PackageService, packagePart };
