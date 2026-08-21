const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { JsonStore } = require('../src/server/json-store');
const { GitRepositoryService } = require('../src/server/git-repository-service');
const { ProjectService } = require('../src/server/project-service');
const { MirrorScheduler } = require('../src/server/mirror-scheduler');
const { createApp } = require('../src/server/app');
const { WorkItemService } = require('../src/server/work-item-service');
const { GitHttpBackend } = require('../src/server/git-http-backend');
const { AuthService } = require('../src/server/auth-service');
const { LfsService } = require('../src/server/lfs-service');
const crypto = require('node:crypto');
const { ContentService } = require('../src/server/content-service');
const { SecretVault } = require('../src/server/secret-vault');
const { WebhookService } = require('../src/server/webhook-service');
const { GroupService } = require('../src/server/group-service');
const { SshKeyService } = require('../src/server/ssh-key-service');
const { GitSshServer, parseGitCommand } = require('../src/server/ssh-server');
const { Client, utils: sshUtils } = require('ssh2');
const { PackageService } = require('../src/server/package-service');
const { BoardService } = require('../src/server/board-service');
const { NotificationService } = require('../src/server/notification-service');
const { SearchService } = require('../src/server/search-service');
const { ContainerRegistryService } = require('../src/server/container-registry-service');
const { StorageQuotaService } = require('../src/server/storage-quota-service');
const { IdentityService, totp } = require('../src/server/identity-service');
const { PolicyService } = require('../src/server/policy-service');
const { UniversalMirrorService } = require('../src/server/universal-mirror-service');
const { ReviewService } = require('../src/server/review-service');
const { MergeQueueService } = require('../src/server/merge-queue-service');
const { DraftService } = require('../src/server/draft-service');
const { QualityGateService, signature: gateSignature } = require('../src/server/quality-gate-service');

describe('KitsuneGIT Web server', { concurrency: 1 }, () => {
  let root;
  let source;
  let projects;
  let server;
  let store;
  let auth;
  let repositories;
  let sshKeys;
  let qualityGates;
  let baseUrl;
  const token = 'test-administrator-token-which-is-long';

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-web-'));
    source = path.join(root, 'source');
    fs.mkdirSync(source);
    repositories = new GitRepositoryService({ repositoriesPath: path.join(root, 'repos'), allowFileRemotes: true });
    await repositories.run(['init', '--initial-branch=main'], { cwd: source });
    fs.writeFileSync(path.join(source, 'README.md'), '# source\n');
    await repositories.run(['add', 'README.md'], { cwd: source });
    await repositories.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Initial'], { cwd: source });
    store = new JsonStore(path.join(root, 'database.json'));
    const secretVault = new SecretVault('ab'.repeat(32));
    projects = new ProjectService({ store, repositories, secretVault });
    auth = new AuthService({ store, adminToken: token });
    const policy = new PolicyService({ store, projects, auth });
    qualityGates = new QualityGateService({ store, projects, secretVault, publicUrl: 'http://127.0.0.1' });
    const workItems = new WorkItemService({ store, projects, policy, qualityGates });
    const reviews = new ReviewService({ projects, store, policy });
    const mergeQueue = new MergeQueueService({ store, workItems, policy });
    const drafts = new DraftService({ store, auth, workItems });
    const identity = new IdentityService({ store, auth, secretVault, rpId: '127.0.0.1', origin: 'http://127.0.0.1' });
    const groups = new GroupService({ store });
    sshKeys = new SshKeyService({ store });
    const quota = new StorageQuotaService({ dataPath: root, projects });
    const packages = new PackageService({ dataPath: root, store, projects, quota });
    const registry = new ContainerRegistryService({ dataPath: root, store, projects, auth, quota });
    const boards = new BoardService({ store, projects });
    const notifications = new NotificationService({ store });
    const search = new SearchService({ store, projects, auth });
    const lfs = new LfsService({ dataPath: root, projects, auth, quota });
    const gitBackend = new GitHttpBackend({ repositoriesPath: repositories.repositoriesPath, databasePath: store.filePath, adminToken: token, auth, projects });
    const content = new ContentService({ store, projects });
    const webhooks = new WebhookService({ store, projects, secretVault });
    server = createApp({ projects, groups, workItems, policy, reviews, mergeQueue, drafts, qualityGates, content, webhooks, gitBackend, lfs, sshKeys, packages, registry, quota, boards, notifications, search, identity, auth, store, adminToken: token });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function api(route, options = {}) {
    return fetch(`${baseUrl}${route}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  }

  it('serves health and rejects unauthenticated API calls', async () => {
    assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/v1/projects`)).status, 401);
  });

  it('bootstraps exactly one administrator with the Plesk token', async () => {
    assert.equal((await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'preexisting-user', name: 'Preexisting User' }) })).status, 201);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/v1/auth/bootstrap`)).json(), { available: true });
    const input = { adminToken: 'wrong-bootstrap-token-value', username: 'primary-admin', name: 'Primary Admin', email: 'admin@example.test', password: 'bootstrap secure password' };
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
    input.adminToken = token;
    const response = await fetch(`${baseUrl}/api/v1/auth/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.user.username, 'primary-admin');
    assert.equal(created.user.email, 'admin@example.test');
    assert.equal(created.user.admin, true);
    assert.match(response.headers.get('set-cookie'), /^kitsune_session=/);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/v1/auth/bootstrap`)).json(), { available: false });
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: input.email, password: input.password }) })).status, 200);
  });

  it('supports password sessions, CSRF, invitations, resets, TOTP, and passkey challenges', async () => {
    const created = await (await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'identity-user', email: 'identity@example.test' }) })).json();
    assert.equal((await api(`/api/v1/users/${created.user.id}/password`, { method: 'PUT', body: JSON.stringify({ password: 'correct horse battery staple' }) })).status, 200);
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'identity@example.test', password: 'correct horse battery staple' }) });
    assert.equal(login.status, 200);
    const loggedIn = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${baseUrl}/api/v1/me`, { headers: { Cookie: cookie } })).status, 200);
    const projectBody = JSON.stringify({ namespace: 'identity-user', name: 'session project' });
    assert.equal((await fetch(`${baseUrl}/api/v1/projects`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: projectBody })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/v1/projects`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': loggedIn.csrfToken, 'Content-Type': 'application/json' }, body: projectBody })).status, 201);
    const passkeyOptions = await fetch(`${baseUrl}/api/v1/auth/passkeys/register/options`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': loggedIn.csrfToken } });
    assert.equal(passkeyOptions.status, 200); assert.ok((await passkeyOptions.json()).options.challenge);
    const enrollment = await (await fetch(`${baseUrl}/api/v1/auth/totp/begin`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': loggedIn.csrfToken } })).json();
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/totp/confirm`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': loggedIn.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: enrollment.ticket, code: totp(enrollment.secret) }) })).status, 200);
    const mfaLogin = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'identity-user', password: 'correct horse battery staple' }) });
    assert.equal(mfaLogin.status, 202); const ticket = (await mfaLogin.json()).ticket;
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/mfa/totp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, code: totp(enrollment.secret) }) })).status, 200);

    const invitation = await (await api('/api/v1/auth/invitations', { method: 'POST', body: JSON.stringify({ email: 'invited@example.test', username: 'invited-user' }) })).json();
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/invitations/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitation.token, password: 'another secure password' }) })).status, 200);
    const reset = await (await api(`/api/v1/users/${created.user.id}/password-reset`, { method: 'POST' })).json();
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/password-reset/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset.token, password: 'replacement secure password' }) })).status, 200);
  });

  it('creates a bare hosted repository', async () => {
    const response = await api('/api/v1/projects', { method: 'POST', body: JSON.stringify({ namespace: 'team', name: 'Hosted Repo' }) });
    assert.equal(response.status, 201);
    const project = await response.json();
    assert.equal(project.slug, 'hosted-repo');
    assert.ok(fs.existsSync(path.join(root, 'repos', 'team', 'hosted-repo.git', 'HEAD')));
  });

  it('imports and summarizes a repository mirror', async () => {
    const project = await projects.import({ namespace: 'team', name: 'mirror', sourceUrl: new URL(`file:///${source.replace(/\\/g, '/')}`).href, mirror: true, mirrorIntervalMinutes: 5 });
    const detail = await projects.detail(project.id);
    assert.equal(detail.repository.commitCount, 1);
    assert.ok(detail.repository.refs.some(ref => ref.name === 'main'));
  });

  it('schedules only due mirrors', async () => {
    const scheduler = new MirrorScheduler({ projects });
    assert.equal(await scheduler.tick(Date.now()), 0);
    assert.equal(await scheduler.tick(Date.now() + 6 * 60_000), 1);
  });

  it('synchronizes Git refs bidirectionally without overwriting divergent refs', async () => {
    const project = projects.list().find(item => item.slug === 'mirror');
    const localRefs = await repositories.refMap(project);
    store.update(state => { const current = state.projects.find(item => item.id === project.id); current.mirrorDirection = 'bidirectional'; current.mirrorRefSnapshot = localRefs; return null; });
    await repositories.run(['tag', 'local-tag', 'refs/heads/main'], { cwd: repositories.pathFor(project) });
    await repositories.run(['checkout', '-b', 'remote-branch'], { cwd: source });
    fs.writeFileSync(path.join(source, 'remote.txt'), 'remote\n'); await repositories.run(['add', 'remote.txt'], { cwd: source });
    await repositories.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Remote ref'], { cwd: source });
    const mirrors = new UniversalMirrorService({ store, projects, providerImports: null });
    const result = await mirrors.sync(project.id, 'test');
    assert.ok(result.refs.changes.some(item => item.ref === 'refs/tags/local-tag' && item.direction === 'push'));
    assert.ok(result.refs.changes.some(item => item.ref === 'refs/heads/remote-branch' && item.direction === 'pull'));
    assert.equal((await repositories.run(['rev-parse', 'refs/heads/remote-branch'], { cwd: repositories.pathFor(project) })).stdout.trim().length, 40);
    assert.equal((await repositories.run(['rev-parse', 'refs/tags/local-tag'], { cwd: source })).stdout.trim().length, 40);
    assert.equal(mirrors.exportManifest(project.id).format, 'kitsune-project-export');
    store.update(state => { state.projects.find(item => item.id === project.id).mirrorDirection = 'pull'; return null; });
  });

  it('prevents duplicate project paths', async () => {
    await assert.rejects(projects.create({ namespace: 'team', name: 'Hosted Repo' }), /already exists/);
  });

  it('hosts repositories over authenticated smart HTTP', async () => {
    const target = path.join(root, 'http-clone');
    const url = new URL(baseUrl);
    url.username = 'git';
    url.password = token;
    const repositories = new GitRepositoryService({ repositoriesPath: path.join(root, 'unused') });
    await repositories.run(['clone', `${url.href.replace(/\/$/, '')}/git/team/mirror.git`, target]);
    assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8').trim(), '# source');
  });

  it('authenticates Git SSH commands with managed user keys', async () => {
    assert.deepEqual(parseGitCommand("git-upload-pack '/team/mirror.git'"), { service: 'git-upload-pack', namespace: 'team', slug: 'mirror' });
    assert.equal(parseGitCommand("sh -c 'git-upload-pack /team/mirror.git'"), null);
    const credentials = await (await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'ssh-user' }) })).json();
    const project = projects.list().find(item => item.slug === 'mirror');
    await api(`/api/v1/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ userId: credentials.user.id, role: 'developer' }) });
    const pair = sshUtils.generateKeyPairSync('ed25519');
    const created = await api(`/api/v1/users/${credentials.user.id}/ssh-keys`, { method: 'POST', body: JSON.stringify({ title: 'Test key', publicKey: pair.public }) });
    assert.equal(created.status, 201);
    const key = await created.json();
    assert.match(key.fingerprint, /^SHA256:/);

    const ssh = new GitSshServer({ dataPath: root, projects, repositories, auth, keys: sshKeys });
    await new Promise((resolve, reject) => {
      ssh.listen(0, '127.0.0.1', resolve);
      ssh.server.once('kitsune-error', reject);
    });
    try {
      const output = await new Promise((resolve, reject) => {
        const client = new Client();
        client.once('ready', () => client.exec("git-upload-pack '/team/mirror.git'", (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          let exitCode;
          let finishedInput = false;
          stream.on('data', chunk => {
            chunks.push(chunk);
            if (!finishedInput) { finishedInput = true; stream.end('0000'); }
          });
          stream.once('exit', code => { exitCode = code; });
          stream.once('close', () => { client.end(); resolve({ exitCode, data: Buffer.concat(chunks) }); });
        }));
        client.once('error', reject);
        client.connect({ host: '127.0.0.1', port: ssh.address().port, username: 'git', privateKey: pair.private, hostVerifier: () => true });
      });
      assert.ok([0, 1].includes(output.exitCode));
      assert.ok(output.data.length > 4);
      const listed = await (await api(`/api/v1/users/${credentials.user.id}/ssh-keys`)).json();
      assert.ok(listed.sshKeys[0].lastUsedAt);
      assert.equal((await api(`/api/v1/users/${credentials.user.id}/ssh-keys/${key.id}`, { method: 'DELETE' })).status, 200);
    } finally {
      await new Promise(resolve => ssh.close(resolve));
    }
  });

  it('creates and closes project issues', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo');
    const created = await api(`/api/v1/projects/${project.id}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Ship web', labels: ['web'] }) });
    assert.equal(created.status, 201);
    const issue = await created.json();
    const closed = await api(`/api/v1/projects/${project.id}/issues/${issue.iid}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    assert.equal((await closed.json()).state, 'closed');
  });

  it('synchronizes versioned offline drafts and exposes conflicts instead of overwriting', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo'); const clientId = crypto.randomUUID();
    const first = await (await api('/api/v1/sync/drafts', { method: 'POST', body: JSON.stringify({ cursor: 0, changes: [{ clientId, projectId: project.id, type: 'issue', version: 0, payload: { title: 'Offline issue', description: 'Prepared without a network' } }] }) })).json();
    assert.equal(first.accepted[0].version, 1); const draftId = first.accepted[0].id;
    const stale = await (await api('/api/v1/sync/drafts', { method: 'POST', body: JSON.stringify({ cursor: first.cursor, changes: [{ clientId, projectId: project.id, type: 'issue', version: 0, payload: { title: 'Stale edit' } }] }) })).json();
    assert.equal(stale.conflicts.length, 1); assert.equal(stale.conflicts[0].server.payload.title, 'Offline issue');
    const published = await api(`/api/v1/drafts/${draftId}/publish`, { method: 'POST' }); assert.equal(published.status, 201); assert.equal((await published.json()).title, 'Offline issue');
  });

  it('uploads and downloads verified Git LFS objects', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo');
    const content = Buffer.from('large binary payload');
    const oid = crypto.createHash('sha256').update(content).digest('hex');
    const base = `/git/${project.namespace}/${project.slug}.git/info/lfs/objects`;
    const batch = await api(`${base}/batch`, { method: 'POST', body: JSON.stringify({ operation: 'upload', objects: [{ oid, size: content.length }] }) });
    assert.equal(batch.status, 200);
    assert.ok((await batch.json()).objects[0].actions.upload.href.endsWith(`/${oid}`));
    const upload = await fetch(`${baseUrl}${base}/${oid}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: content });
    assert.equal(upload.status, 200);
    const download = await fetch(`${baseUrl}${base}/${oid}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  });

  it('publishes immutable generic packages with checksum verification', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo');
    const payload = Buffer.from('package artifact');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const route = `/api/v1/projects/${project.id}/packages/generic/client/1.2.3/client.zip`;
    const uploaded = await fetch(`${baseUrl}${route}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'X-Checksum-Sha256': checksum }, body: payload });
    assert.equal(uploaded.status, 201);
    assert.equal((await uploaded.json()).sha256, checksum);
    assert.equal((await fetch(`${baseUrl}${route}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: payload })).status, 409);
    const downloaded = await fetch(`${baseUrl}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), payload);
  });

  it('reports storage use and enforces project quotas', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo');
    const usage = await (await api(`/api/v1/projects/${project.id}/storage`)).json();
    assert.ok(usage.breakdown.repository > 0);
    await api(`/api/v1/projects/${project.id}/storage`, { method: 'PUT', body: JSON.stringify({ storageLimitBytes: usage.usedBytes + 3 }) });
    const rejected = await fetch(`${baseUrl}/api/v1/projects/${project.id}/packages/generic/limited/1.0.0/file.bin`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: Buffer.from('too large') });
    assert.equal(rejected.status, 413);
    await api(`/api/v1/projects/${project.id}/storage`, { method: 'PUT', body: JSON.stringify({ storageLimitBytes: 0 }) });
  });

  it('implements OCI blob, manifest, and tag distribution endpoints', async () => {
    const payload = Buffer.from('container layer');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${baseUrl}/v2/`)).status, 200);
    const started = await fetch(`${baseUrl}/v2/team/hosted-repo/blobs/uploads/`, { method: 'POST', headers });
    assert.equal(started.status, 202);
    const location = started.headers.get('location');
    assert.equal((await fetch(`${baseUrl}${location}`, { method: 'PATCH', headers, body: payload })).status, 202);
    const completed = await fetch(`${baseUrl}${location}?digest=sha256:${hash}`, { method: 'PUT', headers, body: Buffer.alloc(0) });
    assert.equal(completed.status, 201);
    assert.deepEqual(Buffer.from(await (await fetch(`${baseUrl}/v2/team/hosted-repo/blobs/sha256:${hash}`, { headers })).arrayBuffer()), payload);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${hash}`, size: payload.length }, layers: [] }));
    const published = await fetch(`${baseUrl}/v2/team/hosted-repo/manifests/latest`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/vnd.oci.image.manifest.v1+json' }, body: manifest });
    assert.equal(published.status, 201);
    const tags = await (await fetch(`${baseUrl}/v2/team/hosted-repo/tags/list`, { headers })).json();
    assert.deepEqual(tags.tags, ['latest']);
  });

  it('organizes issues on label-backed boards and searches code', async () => {
    const project = projects.list().find(item => item.slug === 'mirror');
    const issue = await (await api(`/api/v1/projects/${project.id}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Board item' }) })).json();
    const board = await (await api(`/api/v1/projects/${project.id}/boards`, { method: 'POST', body: JSON.stringify({ name: 'Delivery', lists: ['doing', 'done'] }) })).json();
    await api(`/api/v1/projects/${project.id}/boards/${board.id}/issues/${issue.iid}/move`, { method: 'POST', body: JSON.stringify({ listId: board.lists[1].id }) });
    const listed = await (await api(`/api/v1/projects/${project.id}/boards`)).json();
    assert.equal(listed.boards[0].lists[1].issues[0].iid, issue.iid);
    const searched = await (await api(`/api/v1/search?q=${encodeURIComponent('source')}&projectId=${project.id}`)).json();
    assert.ok(searched.code.some(item => item.path === 'README.md'));
  });

  it('delivers per-user project notifications and read state', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo');
    const first = await (await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'notify-author' }) })).json();
    const second = await (await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'notify-reader' }) })).json();
    await api(`/api/v1/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ userId: first.user.id, role: 'developer' }) });
    await api(`/api/v1/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ userId: second.user.id, role: 'reporter' }) });
    const as = (tokenValue, route, options = {}) => fetch(`${baseUrl}${route}`, { ...options, headers: { Authorization: `Bearer ${tokenValue}`, 'Content-Type': 'application/json', ...options.headers } });
    await as(first.token, `/api/v1/projects/${project.id}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Notify the team' }) });
    const inbox = await (await as(second.token, '/api/v1/notifications?unread=true')).json();
    assert.equal(inbox.notifications[0].event, 'issue.created');
    await as(second.token, `/api/v1/notifications/${inbox.notifications[0].id}/read`, { method: 'POST' });
    assert.equal((await (await as(second.token, '/api/v1/notifications?unread=true')).json()).notifications.length, 0);
  });

  it('supports personal tokens and project-scoped ownership', async () => {
    const createdUser = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'alice', name: 'Alice' }) });
    assert.equal(createdUser.status, 201);
    const credentials = await createdUser.json();
    const userApi = (route, options = {}) => fetch(`${baseUrl}${route}`, {
      ...options,
      headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json', ...options.headers }
    });
    const before = await (await userApi('/api/v1/projects')).json();
    assert.equal(before.projects.length, 0);
    const created = await userApi('/api/v1/projects', { method: 'POST', body: JSON.stringify({ namespace: 'alice', name: 'personal' }) });
    assert.equal(created.status, 201);
    const project = await created.json();
    const issue = await userApi(`/api/v1/projects/${project.id}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Owned project' }) });
    assert.equal(issue.status, 201);
    assert.equal((await issue.json()).author, 'alice');
  });

  it('enforces approvals and merges repository refs atomically', async () => {
    const project = projects.list().find(item => item.slug === 'mirror');
    const repositories = projects.repositories;
    await repositories.run(['checkout', '-b', 'feature'], { cwd: source });
    fs.writeFileSync(path.join(source, 'feature.txt'), 'ready\n');
    await repositories.run(['add', 'feature.txt'], { cwd: source });
    await repositories.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Feature'], { cwd: source });
    await projects.sync(project.id, 'test');
    const protection = await api(`/api/v1/projects/${project.id}/protected-branches`, { method: 'POST', body: JSON.stringify({ branch: 'main', requiredApprovals: 1 }) });
    assert.equal(protection.status, 201);
    const created = await api(`/api/v1/projects/${project.id}/merge-requests`, { method: 'POST', body: JSON.stringify({ title: 'Feature', sourceBranch: 'feature', targetBranch: 'main' }) });
    const request = await created.json();
    assert.equal((await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/merge`, { method: 'POST' })).status, 409);
    assert.equal((await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/approve`, { method: 'POST' })).status, 200);
    const review = await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/threads`, { method: 'POST', body: JSON.stringify({ filePath: 'feature.txt', line: 1, body: 'Please confirm this line.' }) });
    const thread = await review.json();
    assert.equal((await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/merge`, { method: 'POST' })).status, 409);
    await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/threads/${thread.id}/replies`, { method: 'POST', body: JSON.stringify({ body: 'Confirmed.' }) });
    await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/threads/${thread.id}/resolve`, { method: 'POST', body: JSON.stringify({ resolved: true }) });
    const merged = await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/merge`, { method: 'POST' });
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).state, 'merged');
    const refs = await repositories.run(['rev-parse', 'refs/heads/main', 'refs/heads/feature'], { cwd: repositories.pathFor(project) });
    const [main, feature] = refs.stdout.trim().split(/\s+/);
    assert.equal(main, feature);

    const bobResponse = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'bob' }) });
    const bob = await bobResponse.json();
    await api(`/api/v1/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ userId: bob.user.id, role: 'developer' }) });
    const checkout = path.join(root, 'bob-clone');
    const remote = new URL(baseUrl); remote.username = 'bob'; remote.password = bob.token;
    await repositories.run(['clone', `${remote.href.replace(/\/$/, '')}/git/team/mirror.git`, checkout]);
    await repositories.run(['checkout', 'main'], { cwd: checkout });
    fs.writeFileSync(path.join(checkout, 'direct.txt'), 'blocked\n');
    await repositories.run(['add', 'direct.txt'], { cwd: checkout });
    await repositories.run(['-c', 'user.name=Bob', '-c', 'user.email=bob@example.test', 'commit', '-m', 'Direct push'], { cwd: checkout });
    await assert.rejects(repositories.run(['push', 'origin', 'main'], { cwd: checkout }), /Protected branch main requires maintainer/);
    await repositories.run(['checkout', '-b', 'bob-feature'], { cwd: checkout });
    await repositories.run(['push', 'origin', 'bob-feature'], { cwd: checkout });
  });

  it('inherits project permissions from nested groups', async () => {
    const userResponse = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'carol' }) });
    const carol = await userResponse.json();
    const parent = await (await api('/api/v1/groups', { method: 'POST', body: JSON.stringify({ name: 'Engineering' }) })).json();
    const child = await (await api('/api/v1/groups', { method: 'POST', body: JSON.stringify({ name: 'Platform', parentId: parent.id }) })).json();
    await api(`/api/v1/groups/${parent.id}/members`, { method: 'POST', body: JSON.stringify({ userId: carol.user.id, role: 'developer' }) });
    const userApi = (route, options = {}) => fetch(`${baseUrl}${route}`, { ...options, headers: { Authorization: `Bearer ${carol.token}`, 'Content-Type': 'application/json', ...options.headers } });
    const created = await userApi('/api/v1/projects', { method: 'POST', body: JSON.stringify({ groupId: child.id, name: 'Inherited access' }) });
    assert.equal(created.status, 201);
    const project = await created.json();
    assert.equal(project.namespace, 'engineering-platform');
    assert.equal((await userApi(`/api/v1/projects/${project.id}`)).status, 200);
  });

  it('explains inherited and expiring permissions and simulates policy decisions', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo');
    const created = await (await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'temporary-user' }) })).json();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    await api(`/api/v1/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ userId: created.user.id, role: 'developer', expiresAt }) });
    const explanation = await (await api(`/api/v1/projects/${project.id}/permissions/explain?userId=${created.user.id}&required=developer`)).json();
    assert.equal(explanation.allowed, true); assert.equal(explanation.sources[0].expiresAt, expiresAt);
    const simulation = await (await api(`/api/v1/projects/${project.id}/policies/simulate`, { method: 'POST', body: JSON.stringify({ userId: created.user.id, action: 'push', branch: 'main' }) })).json();
    assert.equal(simulation.allowed, true);
    store.update(state => { state.memberships.find(item => item.projectId === project.id && item.userId === created.user.id).expiresAt = new Date(Date.now() - 1000).toISOString(); return null; });
    const expired = await (await api(`/api/v1/projects/${project.id}/permissions/explain?userId=${created.user.id}&required=developer`)).json();
    assert.equal(expired.allowed, false); assert.equal(expired.sources[0].active, false);
  });

  it('enforces CODEOWNERS and ruleset reviewers on merges', async () => {
    const project = projects.list().find(item => item.slug === 'mirror');
    await repositories.run(['checkout', 'main'], { cwd: source });
    fs.writeFileSync(path.join(source, 'CODEOWNERS'), '/secure.txt @policy-reviewer\n');
    await repositories.run(['add', 'CODEOWNERS'], { cwd: source });
    await repositories.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Add code owners'], { cwd: source });
    await repositories.run(['checkout', '-b', 'policy-feature'], { cwd: source });
    fs.writeFileSync(path.join(source, 'secure.txt'), 'owned\n');
    await repositories.run(['add', 'secure.txt'], { cwd: source });
    await repositories.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Owned change'], { cwd: source });
    await projects.sync(project.id, 'test');
    const reviewer = await (await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: 'policy-reviewer' }) })).json();
    await api(`/api/v1/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({ userId: reviewer.user.id, role: 'developer' }) });
    await api(`/api/v1/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Owned main', branchPattern: 'main', requireCodeOwners: true, requiredApprovals: 1 }) });
    const request = await (await api(`/api/v1/projects/${project.id}/merge-requests`, { method: 'POST', body: JSON.stringify({ title: 'Owned policy change', sourceBranch: 'policy-feature', targetBranch: 'main' }) })).json();
    await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/approve`, { method: 'POST' });
    assert.equal((await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/merge`, { method: 'POST' })).status, 409);
    const reviewerApi = (route, options = {}) => fetch(`${baseUrl}${route}`, { ...options, headers: { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json', ...options.headers } });
    assert.equal((await reviewerApi(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/approve`, { method: 'POST' })).status, 200);
    assert.equal((await api(`/api/v1/projects/${project.id}/merge-requests/${request.iid}/merge`, { method: 'POST' })).status, 200);
  });

  it('models stacked changes, returns semantic diffs, and merges through a queue', async () => {
    const project = projects.list().find(item => item.slug === 'mirror'); const checkout = path.join(root, 'stack-clone');
    const remote = new URL(baseUrl); remote.username = 'root'; remote.password = token;
    await repositories.run(['clone', `${remote.href.replace(/\/$/, '')}/git/team/mirror.git`, checkout]);
    await repositories.run(['checkout', '-b', 'stack-base'], { cwd: checkout }); fs.writeFileSync(path.join(checkout, 'base.js'), 'function baseFeature() { return true; }\n'); await repositories.run(['add', 'base.js'], { cwd: checkout }); await repositories.run(['-c', 'user.name=Stack', '-c', 'user.email=stack@example.test', 'commit', '-m', 'Stack base'], { cwd: checkout }); await repositories.run(['push', 'origin', 'stack-base'], { cwd: checkout });
    await repositories.run(['checkout', '-b', 'stack-child'], { cwd: checkout }); fs.writeFileSync(path.join(checkout, 'child.js'), 'export function childFeature() { return baseFeature(); }\n'); await repositories.run(['add', 'child.js'], { cwd: checkout }); await repositories.run(['-c', 'user.name=Stack', '-c', 'user.email=stack@example.test', 'commit', '-m', 'Stack child'], { cwd: checkout }); await repositories.run(['push', 'origin', 'stack-child'], { cwd: checkout });
    const baseRequest = await (await api(`/api/v1/projects/${project.id}/merge-requests`, { method: 'POST', body: JSON.stringify({ title: 'Stack base', sourceBranch: 'stack-base', targetBranch: 'main' }) })).json();
    const childRequest = await (await api(`/api/v1/projects/${project.id}/merge-requests`, { method: 'POST', body: JSON.stringify({ title: 'Stack child', sourceBranch: 'stack-child', targetBranch: 'main', dependsOn: [baseRequest.iid] }) })).json();
    const graph = await (await api(`/api/v1/projects/${project.id}/merge-requests/graph`)).json(); assert.ok(graph.edges.some(edge => edge.from === baseRequest.iid && edge.to === childRequest.iid));
    const diff = await (await api(`/api/v1/projects/${project.id}/merge-requests/${childRequest.iid}/semantic-diff`)).json(); assert.ok(diff.files.some(file => file.symbols.includes('childFeature')));
    const currentRule = (await (await api(`/api/v1/projects/${project.id}/rulesets`)).json()).rulesets[0]; await api(`/api/v1/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ ...currentRule, requireMergeQueue: true }) });
    await api(`/api/v1/projects/${project.id}/merge-requests/${baseRequest.iid}/approve`, { method: 'POST' }); await api(`/api/v1/projects/${project.id}/merge-requests/${childRequest.iid}/approve`, { method: 'POST' });
    assert.equal((await api(`/api/v1/projects/${project.id}/merge-requests/${baseRequest.iid}/merge`, { method: 'POST' })).status, 409);
    await api(`/api/v1/projects/${project.id}/merge-queue`, { method: 'POST', body: JSON.stringify({ mergeRequestIid: childRequest.iid }) }); await api(`/api/v1/projects/${project.id}/merge-queue`, { method: 'POST', body: JSON.stringify({ mergeRequestIid: baseRequest.iid }) });
    assert.equal((await (await api(`/api/v1/projects/${project.id}/merge-queue/process`, { method: 'POST' })).json()).processed, 1);
    assert.equal((await (await api(`/api/v1/projects/${project.id}/merge-queue/process`, { method: 'POST' })).json()).processed, 1);
    const requests = await (await api(`/api/v1/projects/${project.id}/merge-requests`)).json(); assert.equal(requests.mergeRequests.find(item => item.iid === childRequest.iid).state, 'merged');
  });

  it('stores releases, versioned wiki pages, snippets, and milestones', async () => {
    const project = projects.list().find(item => item.slug === 'mirror');
    await projects.repositories.run(['tag', 'v1.0.0', 'refs/heads/main'], { cwd: projects.repositories.pathFor(project) });
    const release = await api(`/api/v1/projects/${project.id}/releases`, { method: 'POST', body: JSON.stringify({ tag: 'v1.0.0', name: 'Version 1' }) });
    assert.equal(release.status, 201);
    await api(`/api/v1/projects/${project.id}/wiki`, { method: 'POST', body: JSON.stringify({ title: 'Home', content: 'First' }) });
    await api(`/api/v1/projects/${project.id}/wiki`, { method: 'POST', body: JSON.stringify({ title: 'Home', content: 'Second' }) });
    const wiki = await (await api(`/api/v1/projects/${project.id}/wiki`)).json();
    assert.equal(wiki.wikiPages[0].revisions.length, 2);
    assert.equal((await api(`/api/v1/projects/${project.id}/snippets`, { method: 'POST', body: JSON.stringify({ title: 'Example', fileName: 'example.js', content: 'console.log(1)' }) })).status, 201);
    assert.equal((await api(`/api/v1/projects/${project.id}/milestones`, { method: 'POST', body: JSON.stringify({ title: 'Launch' }) })).status, 201);
  });

  it('stores webhook secrets encrypted and redacts them from API responses', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo');
    const created = await api(`/api/v1/projects/${project.id}/webhooks`, { method: 'POST', body: JSON.stringify({ url: 'https://hooks.example.test/kitsune', events: ['release.created'], secret: 'webhook-secret-value' }) });
    assert.equal(created.status, 201);
    const hook = await created.json();
    assert.equal(hook.hasSecret, true);
    assert.equal(Object.hasOwn(hook, 'secret'), false);
    const listed = await (await api(`/api/v1/projects/${project.id}/webhooks`)).json();
    assert.equal(listed.webhooks[0].url, 'https://hooks.example.test/kitsune');
    assert.equal(JSON.stringify(listed).includes('webhook-secret-value'), false);
  });

  it('accepts only fresh HMAC-signed quality gate results from external providers', async () => {
    const project = projects.list().find(item => item.slug === 'hosted-repo'); const configured = await (await api(`/api/v1/projects/${project.id}/quality-gates`, { method: 'POST', body: JSON.stringify({ name: 'kitsune-test', type: 'kitsune-test', url: 'https://test.example.test/hooks' }) })).json(); const sourceSha = 'a'.repeat(40);
    store.update(state => { state.qualityGateStatuses.push({ id: crypto.randomUUID(), projectId: project.id, mergeRequestIid: 999, providerId: configured.provider.id, name: 'kitsune-test', sourceSha, status: 'pending', updatedAt: new Date().toISOString() }); return null; });
    const body = JSON.stringify({ mergeRequestIid: 999, sourceSha, status: 'success', summary: 'All external checks passed', detailsUrl: 'https://test.example.test/results/1' }); const timestamp = String(Math.floor(Date.now() / 1000));
    assert.equal((await fetch(`${baseUrl}/api/v1/quality-gates/${configured.provider.id}/status`, { method: 'POST', headers: { 'X-Kitsune-Timestamp': timestamp, 'X-Kitsune-Signature': 'sha256=invalid' }, body })).status, 401);
    const accepted = await fetch(`${baseUrl}/api/v1/quality-gates/${configured.provider.id}/status`, { method: 'POST', headers: { 'X-Kitsune-Timestamp': timestamp, 'X-Kitsune-Signature': `sha256=${gateSignature(configured.secret, timestamp, body)}` }, body }); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).status, 'success');
  });
});
