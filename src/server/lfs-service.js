const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function oid(value) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw Object.assign(new Error('LFS object ID is invalid'), { statusCode: 400 });
  return normalized;
}

class LfsService {
  constructor({ dataPath, projects, auth, quota = null, publicUrl = '', maxObjectBytes = 10 * 1024 * 1024 * 1024 }) {
    this.root = path.resolve(dataPath, 'lfs');
    this.projects = projects;
    this.auth = auth;
    this.quota = quota;
    this.publicUrl = String(publicUrl || '').replace(/\/$/, '');
    this.maxObjectBytes = maxObjectBytes;
  }

  objectPath(project, objectId) {
    const safe = oid(objectId);
    return path.join(this.root, project.id, safe.slice(0, 2), safe.slice(2, 4), safe);
  }

  async batch(request, response, project, body, actor) {
    const operation = body.operation;
    if (!['download', 'upload'].includes(operation) || !Array.isArray(body.objects)) throw Object.assign(new Error('LFS batch request is invalid'), { statusCode: 400 });
    if (!this.auth.canProject(project, actor, operation === 'upload' ? 'developer' : 'guest')) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const base = `${this.publicUrl || `http://${request.headers.host}`}/git/${project.namespace}/${project.slug}.git/info/lfs/objects`;
    return {
      transfer: 'basic',
      objects: body.objects.slice(0, 1000).map(item => {
        const objectId = oid(item.oid);
        const size = Number(item.size);
        if (!Number.isSafeInteger(size) || size < 0) throw Object.assign(new Error('LFS object size is invalid'), { statusCode: 400 });
        const exists = fs.statSync(this.objectPath(project, objectId), { throwIfNoEntry: false })?.size === size;
        if (operation === 'download' && !exists) return { oid: objectId, size, error: { code: 404, message: 'Object not found' } };
        return { oid: objectId, size, actions: exists && operation === 'upload' ? {} : { [operation]: { href: `${base}/${objectId}`, header: {} } } };
      })
    };
  }

  download(response, project, objectId, actor) {
    if (!this.auth.canProject(project, actor, 'guest')) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const file = this.objectPath(project, objectId);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw Object.assign(new Error('LFS object not found'), { statusCode: 404 });
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=31536000, immutable' });
    fs.createReadStream(file).pipe(response);
  }

  upload(request, response, project, objectId, actor) {
    if (!this.auth.canProject(project, actor, 'developer')) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const safeOid = oid(objectId);
    const declaredSize = Number(request.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > this.maxObjectBytes) throw Object.assign(new Error('LFS object exceeds the instance limit'), { statusCode: 413 });
    this.quota?.assert(project.id, Number.isFinite(declaredSize) ? declaredSize : 0);
    const target = this.objectPath(project, safeOid);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const output = fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' });
    const hash = crypto.createHash('sha256');
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > this.maxObjectBytes) request.destroy(Object.assign(new Error('LFS object exceeds the instance limit'), { statusCode: 413 }));
      else hash.update(chunk);
    });
    request.pipe(output);
    const fail = error => { fs.rmSync(temporary, { force: true }); if (!response.headersSent) { response.writeHead(error.statusCode || 500); response.end(error.message); } };
    request.once('error', fail); output.once('error', fail);
    output.once('finish', () => {
      if (hash.digest('hex') !== safeOid) return fail(Object.assign(new Error('LFS object checksum mismatch'), { statusCode: 422 }));
      try { this.quota?.assert(project.id, 0); } catch (error) { return fail(error); }
      if (process.platform === 'win32') fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '2' }); response.end('{}');
    });
  }
}

module.exports = { LfsService, oid };
