const http = require('node:http');
const https = require('node:https');

function coordinates(provider, sourceUrl) {
  const parsed = new URL(sourceUrl);
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Provider repository path is invalid');
  if (['github', 'gitea'].includes(provider) && parts.length !== 2) throw new Error(`${provider} repository path must contain owner and repository`);
  return { owner: parts.slice(0, -1).join('/'), repo: parts.at(-1), fullPath: parts.join('/') };
}

class ProviderImportService {
  async inspect({ provider, sourceUrl, token, apiBaseUrl }) {
    if (!['github', 'gitlab', 'gitea'].includes(provider)) return null;
    const repo = coordinates(provider, sourceUrl);
    const githubLike = ['github', 'gitea'].includes(provider);
    const baseUrl = apiBaseUrl || (provider === 'github' ? 'https://api.github.com' : provider === 'gitea' ? `${new URL(sourceUrl).origin}/api/v1` : `${new URL(sourceUrl).origin}/api/v4`);
    const cleanBase = new URL(baseUrl);
    if (cleanBase.protocol !== 'https:' || cleanBase.username || cleanBase.password || cleanBase.search || cleanBase.hash) throw new Error('Provider API URL must use clean HTTPS');
    const encoded = encodeURIComponent(repo.fullPath);
    const metadataPath = githubLike ? `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}` : `/projects/${encoded}`;
    const issuesPath = githubLike ? `${metadataPath}/issues?state=all&limit=100` : `${metadataPath}/issues?scope=all&state=all&per_page=100`;
    const requestsPath = githubLike ? `${metadataPath}/pulls?state=all&limit=100` : `${metadataPath}/merge_requests?scope=all&state=all&per_page=100`;
    const [metadata, issuesRaw, requestsRaw] = await Promise.all([
      this._request(cleanBase, metadataPath, provider, token),
      this._request(cleanBase, issuesPath, provider, token),
      this._request(cleanBase, requestsPath, provider, token)
    ]);
    const issues = (Array.isArray(issuesRaw) ? issuesRaw : []).filter(item => !githubLike || !item.pull_request).map(item => ({
      external: { provider, id: String(item.id), iid: Number(item.number ?? item.iid), updatedAt: item.updated_at || item.created_at || new Date().toISOString() },
      iid: Number(item.number ?? item.iid), title: String(item.title || '').slice(0, 500),
      description: String(item.body ?? item.description ?? '').slice(0, 100_000),
      state: item.state === 'closed' ? 'closed' : 'open',
      labels: (item.labels || []).slice(0, 20).map(label => String(label.name || label).slice(0, 64)),
      author: String(item.user?.login || item.author?.username || 'imported').slice(0, 256),
      createdAt: item.created_at || new Date().toISOString(), updatedAt: item.updated_at || item.created_at || new Date().toISOString()
    }));
    const mergeRequests = (Array.isArray(requestsRaw) ? requestsRaw : []).map(item => ({
      external: { provider, id: String(item.id), iid: Number(item.number ?? item.iid), updatedAt: item.updated_at || item.created_at || new Date().toISOString() },
      iid: Number(item.number ?? item.iid), title: String(item.title || '').slice(0, 500),
      description: String(item.body ?? item.description ?? '').slice(0, 100_000),
      sourceBranch: String(item.head?.ref || item.source_branch || '').slice(0, 1024),
      targetBranch: String(item.base?.ref || item.target_branch || '').slice(0, 1024),
      state: ['closed', 'merged'].includes(item.state) ? item.state : 'open', draft: Boolean(item.draft),
      author: String(item.user?.login || item.author?.username || 'imported').slice(0, 256),
      createdAt: item.created_at || new Date().toISOString(), updatedAt: item.updated_at || item.created_at || new Date().toISOString()
    }));
    return {
      description: String(metadata.description || '').slice(0, 10_000),
      visibility: metadata.private === false || metadata.visibility === 'public' ? 'public' : 'private',
      defaultBranch: String(metadata.default_branch || 'main').slice(0, 1024), topics: (metadata.topics || metadata.tag_list || []).slice(0, 50),
      issues, mergeRequests
    };
  }

  _request(baseUrl, route, provider, token, options = {}) {
    const target = new URL(`${baseUrl.href.replace(/\/$/, '')}${route}`);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', 'User-Agent': 'KitsuneGIT-Web' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (provider === 'github') headers['X-GitHub-Api-Version'] = '2026-03-10';
    let payload = null;
    if (options.body) { payload = Buffer.from(JSON.stringify(options.body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    return new Promise((resolve, reject) => {
      const request = transport.request(target, { method: options.method || 'GET', headers }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) request.destroy(new Error('Provider response exceeded 8 MiB')); else chunks.push(chunk); });
        response.once('error', reject);
        response.once('end', () => {
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return reject(new Error('Provider returned invalid JSON')); }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Provider import failed: ${String(body.message || `HTTP ${response.statusCode}`).slice(0, 1000)}`));
          resolve(body);
        });
      });
      request.setTimeout(30_000, () => request.destroy(new Error('Provider import timed out')));
      request.once('error', reject); request.end(payload);
    });
  }

  async writeWorkItem({ provider, sourceUrl, token, type, item, apiBaseUrl }) {
    if (!['github', 'gitlab', 'gitea'].includes(provider) || !token) throw new Error('Provider and token are required for metadata push');
    const githubLike = ['github', 'gitea'].includes(provider); const repo = coordinates(provider, sourceUrl); const baseUrl = new URL(apiBaseUrl || (provider === 'github' ? 'https://api.github.com' : provider === 'gitea' ? `${new URL(sourceUrl).origin}/api/v1` : `${new URL(sourceUrl).origin}/api/v4`));
    const root = githubLike ? `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}` : `/projects/${encodeURIComponent(repo.fullPath)}`;
    let route; let method; let body;
    if (type === 'issue') {
      const externalIid = item.external?.iid;
      route = `${root}/issues${externalIid ? `/${externalIid}` : ''}`;
      method = externalIid ? (githubLike ? 'PATCH' : 'PUT') : 'POST';
      body = githubLike ? { title: item.title, body: item.description, state: item.state, labels: item.labels || [] } : { title: item.title, description: item.description, state_event: item.state === 'closed' ? 'close' : 'reopen', labels: (item.labels || []).join(',') };
    } else {
      const externalIid = item.external?.iid;
      route = githubLike ? `${root}/pulls${externalIid ? `/${externalIid}` : ''}` : `${root}/merge_requests${externalIid ? `/${externalIid}` : ''}`;
      method = externalIid ? (githubLike ? 'PATCH' : 'PUT') : 'POST';
      body = githubLike ? { title: item.title, body: item.description, head: item.sourceBranch, base: item.targetBranch, state: item.state === 'closed' ? 'closed' : 'open', draft: Boolean(item.draft) } : { title: item.title, description: item.description, source_branch: item.sourceBranch, target_branch: item.targetBranch, state_event: item.state === 'closed' ? 'close' : item.state === 'merged' ? undefined : 'reopen' };
    }
    const result = await this._request(baseUrl, route, provider, token, { method, body });
    return { provider, id: String(result.id), iid: Number(result.number ?? result.iid), updatedAt: result.updated_at || new Date().toISOString() };
  }
}

module.exports = { ProviderImportService, coordinates };
