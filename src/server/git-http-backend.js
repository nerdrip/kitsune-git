const { spawn } = require('node:child_process');

function authorized(request, token) {
  const header = request.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7) === token;
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1) === token;
  } catch { return false; }
}

class GitHttpBackend {
  constructor({ repositoriesPath, databasePath, adminToken, auth = null, gitExecutable = 'git', projects }) {
    this.repositoriesPath = repositoriesPath;
    this.adminToken = adminToken;
    this.auth = auth;
    this.gitExecutable = gitExecutable;
    this.projects = projects;
    this.databasePath = databasePath;
  }

  async handle(request, response, url, match) {
    const project = this.projects.getByPath(match[1], match[2]);
    const write = request.method === 'POST' && url.pathname.endsWith('/git-receive-pack');
    const actor = this.auth ? this.auth.authenticate(request) : (authorized(request, this.adminToken) ? { id: 'root', username: 'administrator', admin: true } : null);
    const allowed = this.auth ? this.auth.canProject(project, actor, write ? 'developer' : 'guest') : (Boolean(actor) || (!write && project.visibility === 'public'));
    if (!allowed) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="KitsuneGIT"', 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Authentication required\n');
    }
    const pathInfo = url.pathname.slice(4);
    const child = spawn(this.gitExecutable, ['http-backend'], {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: this.repositoriesPath,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: pathInfo,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: request.headers['content-length'] || '',
        REMOTE_USER: actor?.username || '',
        KITSUNE_DATA_FILE: this.databasePath || '',
        KITSUNE_PROJECT_ID: project.id,
        KITSUNE_ACTOR_ID: actor?.id || '',
        KITSUNE_ACTOR_ADMIN: actor?.admin ? '1' : '0',
        KITSUNE_DEFAULT_STORAGE_LIMIT_BYTES: String(project.storageLimitBytes || 0)
      }
    });
    request.pipe(child.stdin);
    let headersSent = false;
    let buffered = Buffer.alloc(0);
    child.stdout.on('data', chunk => {
      if (headersSent) return response.write(chunk);
      buffered = Buffer.concat([buffered, chunk]);
      const boundary = buffered.indexOf('\r\n\r\n');
      if (boundary === -1) {
        if (buffered.length > 64 * 1024) child.kill();
        return;
      }
      const headerText = buffered.subarray(0, boundary).toString('utf8');
      const headers = {};
      let status = 200;
      for (const line of headerText.split('\r\n')) {
        const separator = line.indexOf(':');
        if (separator < 1) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
        else headers[key] = value;
      }
      headers['Cache-Control'] = 'no-store';
      response.writeHead(status, headers);
      headersSent = true;
      response.write(buffered.subarray(boundary + 4));
      buffered = null;
    });
    const errors = [];
    child.stderr.on('data', chunk => { if (errors.reduce((sum, value) => sum + value.length, 0) < 64 * 1024) errors.push(chunk); });
    child.once('error', error => { if (!response.headersSent) response.writeHead(500); response.end(error.message); });
    child.once('close', code => {
      if (!headersSent) {
        response.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(code === 0 ? buffered : Buffer.concat(errors).toString('utf8'));
      } else response.end();
    });
  }
}

module.exports = { GitHttpBackend, authorized };
