const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function registryJson(response, status, value, headers = {}) {
  const data = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Docker-Distribution-Api-Version': 'registry/2.0', ...headers }); response.end(data);
}

function digest(value) { const match = /^sha256:([a-f0-9]{64})$/.exec(String(value || '').toLowerCase()); if (!match) throw Object.assign(new Error('Digest is invalid'), { statusCode: 400 }); return match[1]; }
function reference(value) { if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(String(value || ''))) throw Object.assign(new Error('Manifest reference is invalid'), { statusCode: 400 }); return String(value); }

class ContainerRegistryService {
  constructor({ dataPath, store, projects, auth, quota = null, maxBlobBytes = 10 * 1024 * 1024 * 1024 }) { this.root = path.resolve(dataPath, 'registry'); this.store = store; this.projects = projects; this.auth = auth; this.quota = quota; this.maxBlobBytes = maxBlobBytes; }
  _error(response, error) { registryJson(response, error.statusCode || 500, { errors: [{ code: error.statusCode === 404 ? 'BLOB_UNKNOWN' : 'DENIED', message: error.statusCode ? error.message : 'Registry error' }] }); }
  _project(namespace, slug, actor, role) { const project = this.projects.getByPath(namespace, slug); this.auth.requireProject(project.id, actor, role); return project; }
  _blobPath(hash) { return path.join(this.root, 'blobs', 'sha256', hash.slice(0, 2), hash); }
  _uploadPath(id) { return path.join(this.root, 'uploads', id); }
  _manifestPath(projectId, hash) { return path.join(this.root, 'manifests', projectId, hash); }

  async _stream(request, target, append = false) {
    fs.mkdirSync(path.dirname(target), { recursive: true }); let size = append && fs.existsSync(target) ? fs.statSync(target).size : 0;
    await new Promise((resolve, reject) => { const output = fs.createWriteStream(target, { flags: append ? 'a' : 'wx', mode: 0o600 }); request.on('data', chunk => { size += chunk.length; if (size > this.maxBlobBytes) request.destroy(Object.assign(new Error('Registry blob is too large'), { statusCode: 413 })); }); request.once('error', reject); output.once('error', reject); output.once('finish', resolve); request.pipe(output); }); return size;
  }

  async handle(request, response, url, authenticate) {
    response.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
    if (url.pathname === '/v2/' && request.method === 'GET') { response.writeHead(200); return response.end(); }
    const actor = authenticate(request);
    if (!actor) { response.setHeader('WWW-Authenticate', 'Basic realm="KitsuneGIT Container Registry"'); return this._error(response, Object.assign(new Error('Authentication required'), { statusCode: 401 })); }
    try {
      let match = /^\/v2\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/blobs\/uploads\/?$/.exec(url.pathname);
      if (match && request.method === 'POST') {
        const project = this._project(match[1], match[2], actor, 'developer'); const id = crypto.randomUUID(); const target = this._uploadPath(id); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '', { mode: 0o600 });
        response.writeHead(202, { Location: `/v2/${match[1]}/${match[2]}/blobs/uploads/${id}`, 'Docker-Upload-UUID': id, Range: '0-0' }); return response.end();
      }
      match = /^\/v2\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/blobs\/uploads\/([0-9a-f-]+)$/.exec(url.pathname);
      if (match && ['PATCH', 'PUT'].includes(request.method)) {
        const project = this._project(match[1], match[2], actor, 'developer'); const target = this._uploadPath(match[3]); if (!fs.existsSync(target)) throw Object.assign(new Error('Upload not found'), { statusCode: 404 }); this.quota?.assert(project.id, Number(request.headers['content-length']) || 0); const size = await this._stream(request, target, true);
        if (request.method === 'PATCH') { response.writeHead(202, { Location: url.pathname, 'Docker-Upload-UUID': match[3], Range: `0-${Math.max(0, size - 1)}` }); return response.end(); }
        const hash = digest(url.searchParams.get('digest')); const actual = await new Promise((resolve, reject) => { const sum = crypto.createHash('sha256'); const input = fs.createReadStream(target); input.on('data', chunk => sum.update(chunk)); input.once('error', reject); input.once('end', () => resolve(sum.digest('hex'))); });
        if (actual !== hash) throw Object.assign(new Error('Blob digest does not match'), { statusCode: 422 }); this.quota?.assert(project.id, size); const destination = this._blobPath(hash); fs.mkdirSync(path.dirname(destination), { recursive: true }); if (fs.existsSync(destination)) fs.rmSync(target); else fs.renameSync(target, destination);
        this.store.update(state => { if (!state.containerBlobs.some(item => item.projectId === project.id && item.digest === `sha256:${hash}`)) state.containerBlobs.push({ projectId: project.id, digest: `sha256:${hash}`, size, createdAt: new Date().toISOString() }); return null; }, { actor: actor.username, action: 'registry.blob', target: hash });
        response.writeHead(201, { Location: `/v2/${match[1]}/${match[2]}/blobs/sha256:${hash}`, 'Docker-Content-Digest': `sha256:${hash}` }); return response.end();
      }
      match = /^\/v2\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/blobs\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
      if (match && ['GET', 'HEAD'].includes(request.method)) { const project = this._project(match[1], match[2], actor, 'guest'); const hash = digest(match[3]); if (!this.store.snapshot().containerBlobs.some(item => item.projectId === project.id && item.digest === match[3])) throw Object.assign(new Error('Blob not found'), { statusCode: 404 }); const target = this._blobPath(hash); const size = fs.statSync(target).size; response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Docker-Content-Digest': match[3] }); return request.method === 'HEAD' ? response.end() : fs.createReadStream(target).pipe(response); }
      match = /^\/v2\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/manifests\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
      if (match && request.method === 'PUT') {
        const project = this._project(match[1], match[2], actor, 'developer'); const ref = reference(match[3]); const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 10 * 1024 * 1024) throw Object.assign(new Error('Manifest is too large'), { statusCode: 413 }); chunks.push(chunk); } const data = Buffer.concat(chunks); let manifest; try { manifest = JSON.parse(data.toString('utf8')); } catch { throw Object.assign(new Error('Manifest must be valid JSON'), { statusCode: 400 }); } const references = [manifest.config, ...(Array.isArray(manifest.layers) ? manifest.layers : [])].filter(Boolean).map(item => String(item.digest || '')); const known = new Set(this.store.snapshot().containerBlobs.filter(item => item.projectId === project.id).map(item => item.digest)); if (references.some(item => !known.has(item))) throw Object.assign(new Error('Manifest references an unknown blob'), { statusCode: 400 }); const hash = crypto.createHash('sha256').update(data).digest('hex'); const target = this._manifestPath(project.id, hash); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, { mode: 0o600 }); const item = { projectId: project.id, reference: ref, digest: `sha256:${hash}`, mediaType: String(request.headers['content-type'] || 'application/vnd.oci.image.manifest.v1+json').split(';')[0], size, createdAt: new Date().toISOString() };
        this.store.update(state => { state.containerManifests = state.containerManifests.filter(value => !(value.projectId === project.id && value.reference === ref)); state.containerManifests.push(item); return null; }, { actor: actor.username, action: 'registry.manifest', target: `${project.id}:${ref}` }); response.writeHead(201, { Location: url.pathname, 'Docker-Content-Digest': item.digest }); return response.end();
      }
      if (match && ['GET', 'HEAD'].includes(request.method)) { const project = this._project(match[1], match[2], actor, 'guest'); const item = this.store.snapshot().containerManifests.find(value => value.projectId === project.id && (value.reference === match[3] || value.digest === match[3])); if (!item) throw Object.assign(new Error('Manifest not found'), { statusCode: 404 }); const data = fs.readFileSync(this._manifestPath(project.id, digest(item.digest))); response.writeHead(200, { 'Content-Type': item.mediaType, 'Content-Length': data.length, 'Docker-Content-Digest': item.digest }); return request.method === 'HEAD' ? response.end() : response.end(data); }
      match = /^\/v2\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/tags\/list$/.exec(url.pathname);
      if (match && request.method === 'GET') { const project = this._project(match[1], match[2], actor, 'guest'); const tags = this.store.snapshot().containerManifests.filter(item => item.projectId === project.id && !item.reference.startsWith('sha256:')).map(item => item.reference); return registryJson(response, 200, { name: `${match[1]}/${match[2]}`, tags }); }
      throw Object.assign(new Error('Registry route not found'), { statusCode: 404 });
    } catch (error) { return this._error(response, error); }
  }
}

module.exports = { ContainerRegistryService, digest, reference };
