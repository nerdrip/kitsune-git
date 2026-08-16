const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { AuthService } = require('./auth-service');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  response.end(payload);
}
function binary(response, status, content, contentType, fileName) { response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': content.length, 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(content); }

function readJson(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) request.destroy(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
      else chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 })); }
    });
  });
}

function readText(request, limit = 1024 * 1024) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; request.on('data', chunk => { size += chunk.length; if (size > limit) request.destroy(Object.assign(new Error('Request body is too large'), { statusCode: 413 })); else chunks.push(chunk); }); request.once('error', reject); request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); }); }

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createApp({ projects, groups, workItems, policy, mirrors, forgeMesh, collaborationRefs, changeIntelligence, policyEvidence, changeBundles, attention, reviews, mergeQueue, drafts, qualityGates, previews, ai, content, webhooks, gitBackend, lfs, sshKeys, packages, registry, quota, boards, notifications, search, identity, externalAuth, auth, store, adminToken, publicPath = path.join(__dirname, 'public') }) {
  if (typeof adminToken !== 'string' || adminToken.length < 24) throw new Error('KITSUNE_ADMIN_TOKEN must contain at least 24 characters');
  const authentication = auth || new AuthService({ store, adminToken });
  const emitEvent = (projectId, event, data, actor = null) => { if (webhooks) void webhooks.emit(projectId, event, data); notifications?.emit(projectId, event, data, actor); if (collaborationRefs) { collaborationRefs.record(projectId, event, { id: data?.id, iid: data?.iid }, actor?.username || 'system'); void collaborationRefs.publish(projectId, actor?.username || 'system').catch(() => {}); } };

  return http.createServer(async (request, response) => {
    const requestId = crypto.randomUUID();
    response.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/v1/health' && request.method === 'GET') return json(response, 200, { status: 'ok', service: 'kitsune-web' });
      if (url.pathname === '/api/v1/ready' && request.method === 'GET') { store.snapshot(); return json(response, 200, { status: 'ready', metadataBackend: store.constructor.name === 'SqliteStore' ? 'sqlite' : 'json' }); }

      if (identity && url.pathname.startsWith('/api/v1/auth/')) {
        const context = { ip: request.headers['x-real-ip'] || request.socket.remoteAddress || '', userAgent: request.headers['user-agent'] || '' };
        const secureCookie = request.headers['x-forwarded-proto'] === 'https' || Boolean(request.socket.encrypted);
        const establish = result => {
          if (result.mfaRequired) return json(response, 202, result);
          response.setHeader('Set-Cookie', identity.sessionCookie(result.session.token, secureCookie));
          return json(response, 200, { user: result.user, csrfToken: result.session.csrfToken, expiresAt: result.session.expiresAt });
        };
        if (url.pathname === '/api/v1/auth/providers' && request.method === 'GET') return json(response, 200, externalAuth?.capabilities() || { oidc: false, ldap: false });
        if (url.pathname === '/api/v1/auth/oidc/start' && request.method === 'GET' && externalAuth) { response.writeHead(302, { Location: await externalAuth.beginOidc(), 'Cache-Control': 'no-store' }); return response.end(); }
        if (url.pathname === '/api/v1/auth/oidc/callback' && request.method === 'GET' && externalAuth) { const result = await externalAuth.completeOidc(Object.fromEntries(url.searchParams), context); response.setHeader('Set-Cookie', identity.sessionCookie(result.session.token, secureCookie)); response.writeHead(302, { Location: '/?login=oidc', 'Cache-Control': 'no-store' }); return response.end(); }
        if (url.pathname === '/api/v1/auth/ldap' && request.method === 'POST' && externalAuth) return establish(await externalAuth.loginLdap(await readJson(request), context));
        if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') return establish(await identity.login(await readJson(request), context));
        if (url.pathname === '/api/v1/auth/invitations/accept' && request.method === 'POST') return establish(await identity.acceptInvitation(await readJson(request), context));
        if (url.pathname === '/api/v1/auth/password-reset/complete' && request.method === 'POST') return json(response, 200, await identity.completePasswordReset(await readJson(request)));
        if (url.pathname === '/api/v1/auth/mfa/totp' && request.method === 'POST') return establish(identity.completeTotpLogin(await readJson(request), context));
        if (url.pathname === '/api/v1/auth/passkeys/options' && request.method === 'POST') { const body = await readJson(request); return json(response, 200, await identity.passkeyAuthenticationOptions(body.identifier)); }
        if (url.pathname === '/api/v1/auth/passkeys/verify' && request.method === 'POST') return establish(await identity.verifyPasskeyAuthentication(await readJson(request), context));
      }
      const qualityCallbackMatch = /^\/api\/v1\/quality-gates\/([0-9a-f-]+)\/status$/.exec(url.pathname);
      if (qualityCallbackMatch && qualityGates && request.method === 'POST') return json(response, 200, qualityGates.receive(qualityCallbackMatch[1], await readText(request), request.headers));

      const lfsBatch = /^\/git\/([a-z0-9._-]+)\/([a-z0-9._-]+)\.git\/info\/lfs\/objects\/batch$/.exec(url.pathname);
      const lfsObject = /^\/git\/([a-z0-9._-]+)\/([a-z0-9._-]+)\.git\/info\/lfs\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
      if ((lfsBatch || lfsObject) && lfs) {
        const match = lfsBatch || lfsObject;
        const project = projects.getByPath(match[1], match[2]);
        const actor = authentication.authenticate(request);
        if (lfsBatch && request.method === 'POST') return json(response, 200, await lfs.batch(request, response, project, await readJson(request), actor));
        if (lfsObject && request.method === 'GET') return lfs.download(response, project, match[3], actor);
        if (lfsObject && request.method === 'PUT') return lfs.upload(request, response, project, match[3], actor);
      }

      const gitMatch = /^\/git\/([a-z0-9._-]+)\/([a-z0-9._-]+)\.git(?:\/.*)?$/.exec(url.pathname);
      if (gitMatch && gitBackend) return await gitBackend.handle(request, response, url, gitMatch);
      if (url.pathname === '/v2/' || url.pathname.startsWith('/v2/')) return registry ? await registry.handle(request, response, url, value => authentication.authenticate(value)) : json(response, 404, { error: 'Container registry is disabled' });

      if (url.pathname.startsWith('/api/')) {
        const actor = authentication.authenticate(request);
        if (!actor) {
          return json(response, 401, { error: 'Authentication required', requestId });
        }
        authentication.requireCsrf(request, actor);
        if (url.pathname === '/api/v1/me' && request.method === 'GET') return json(response, 200, actor);
        if (url.pathname === '/api/v1/sync/drafts' && request.method === 'POST' && drafts) return json(response, 200, drafts.sync(await readJson(request), actor));
        const draftPublishMatch = /^\/api\/v1\/drafts\/([0-9a-f-]+)\/publish$/.exec(url.pathname);
        if (draftPublishMatch && request.method === 'POST' && drafts) return json(response, 201, drafts.publish(draftPublishMatch[1], actor));
        if (url.pathname === '/api/v1/auth/logout' && request.method === 'POST' && identity) { identity.logout(actor); response.setHeader('Set-Cookie', identity.clearCookie(request.headers['x-forwarded-proto'] === 'https' || Boolean(request.socket.encrypted))); return json(response, 200, { loggedOut: true }); }
        if (url.pathname === '/api/v1/auth/sessions' && request.method === 'GET' && identity) return json(response, 200, { sessions: identity.sessions(actor) });
        const sessionMatch = /^\/api\/v1\/auth\/sessions\/([0-9a-f-]+)$/.exec(url.pathname);
        if (sessionMatch && request.method === 'DELETE' && identity) return json(response, 200, identity.revokeSession(sessionMatch[1], actor));
        if (url.pathname === '/api/v1/auth/totp/begin' && request.method === 'POST' && identity) return json(response, 200, identity.beginTotp(actor));
        if (url.pathname === '/api/v1/auth/totp/confirm' && request.method === 'POST' && identity) return json(response, 200, identity.confirmTotp(await readJson(request), actor));
        if (url.pathname === '/api/v1/auth/passkeys/register/options' && request.method === 'POST' && identity) return json(response, 200, await identity.passkeyRegistrationOptions(actor));
        if (url.pathname === '/api/v1/auth/passkeys/register/verify' && request.method === 'POST' && identity) return json(response, 201, await identity.verifyPasskeyRegistration(await readJson(request), actor));
        if (url.pathname === '/api/v1/auth/passkeys' && request.method === 'GET' && identity) return json(response, 200, { passkeys: identity.passkeys(actor) });
        const passkeyMatch = /^\/api\/v1\/auth\/passkeys\/([0-9a-f-]+)$/.exec(url.pathname);
        if (passkeyMatch && request.method === 'DELETE' && identity) return json(response, 200, identity.removePasskey(passkeyMatch[1], actor));
        if (url.pathname === '/api/v1/auth/invitations' && request.method === 'POST' && identity) return json(response, 201, identity.createInvitation(await readJson(request), actor));
        const genericPackageMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/packages\/generic\/([a-z0-9._-]+)\/([A-Za-z0-9._+-]+)\/([A-Za-z0-9._+-]+)$/.exec(url.pathname);
        if (genericPackageMatch && packages) {
          const packageInput = { name: genericPackageMatch[2], version: genericPackageMatch[3], fileName: genericPackageMatch[4], sha256: request.headers['x-checksum-sha256'] };
          if (request.method === 'PUT') { authentication.requireProject(genericPackageMatch[1], actor, 'developer'); return json(response, 201, await packages.upload(request, genericPackageMatch[1], packageInput, actor.username)); }
          if (request.method === 'GET') { authentication.requireProject(genericPackageMatch[1], actor, 'guest'); return packages.download(response, genericPackageMatch[1], packageInput); }
        }
        if (url.pathname === '/api/v1/projects' && request.method === 'GET') return json(response, 200, { projects: projects.list().filter(project => authentication.canProject(project, actor, 'guest')) });
        if (url.pathname === '/api/v1/projects' && request.method === 'POST') {
          const input = groups ? groups.prepareProjectInput(await readJson(request), actor) : await readJson(request);
          const project = await projects.create(input, actor.username); authentication.grantOwner(project.id, actor.id); emitEvent(project.id, 'project.created', project); return json(response, 201, project);
        }
        if (url.pathname === '/api/v1/imports' && request.method === 'POST') {
          const input = groups ? groups.prepareProjectInput(await readJson(request), actor) : await readJson(request);
          const project = await projects.import(input, actor.username); authentication.grantOwner(project.id, actor.id); emitEvent(project.id, 'project.created', project); return json(response, 202, project);
        }
        if (url.pathname === '/api/v1/audit' && request.method === 'GET') { authentication.requireAdmin(actor); return json(response, 200, { events: store.snapshot().audit.slice().reverse() }); }
        if (url.pathname === '/api/v1/system/capabilities' && request.method === 'GET') { authentication.requireAdmin(actor); const sqlite = store.constructor.name === 'SqliteStore'; return json(response, 200, { metadataBackend: sqlite ? 'sqlite-wal' : 'json-single-writer', multiProcessTransactions: sqlite, schedulerLeases: sqlite, objectStorage: 'filesystem', ci: 'external-kitsune-test-future-adapter' }); }
        if (url.pathname === '/api/v1/search' && request.method === 'GET' && search) return json(response, 200, await search.search(url.searchParams.get('q'), actor, url.searchParams.get('projectId')));
        if (url.pathname === '/api/v1/attention' && request.method === 'GET' && attention) return json(response, 200, { items: attention.inbox(actor) });
        if (url.pathname === '/api/v1/attention/digest' && request.method === 'GET' && attention) return json(response, 200, attention.digest(actor));
        const attentionMatch = /^\/api\/v1\/attention\/([^/]+)$/.exec(url.pathname);
        if (attentionMatch && request.method === 'PATCH' && attention) return json(response, 200, attention.update(decodeURIComponent(attentionMatch[1]), await readJson(request), actor));
        if (url.pathname === '/api/v1/change-intelligence/catalog' && request.method === 'GET' && changeIntelligence) return json(response, 200, await changeIntelligence.catalog());
        if (url.pathname === '/api/v1/notifications' && request.method === 'GET' && notifications) return json(response, 200, { notifications: notifications.list(actor, url.searchParams.get('unread') === 'true') });
        const notificationMatch = /^\/api\/v1\/notifications\/([0-9a-f-]+)\/read$/.exec(url.pathname);
        if (notificationMatch && request.method === 'POST' && notifications) return json(response, 200, notifications.markRead(notificationMatch[1], actor));
        if (url.pathname === '/api/v1/users' && request.method === 'GET') { authentication.requireAdmin(actor); return json(response, 200, { users: authentication.listUsers() }); }
        if (url.pathname === '/api/v1/users' && request.method === 'POST') return json(response, 201, authentication.createUser(await readJson(request), actor));
        if (url.pathname === '/api/v1/groups' && request.method === 'GET' && groups) return json(response, 200, { groups: groups.list(actor) });
        if (url.pathname === '/api/v1/groups' && request.method === 'POST' && groups) return json(response, 201, groups.create(await readJson(request), actor));
        const groupMemberMatch = /^\/api\/v1\/groups\/([0-9a-f-]+)\/members$/.exec(url.pathname);
        if (groupMemberMatch && groups && request.method === 'GET') return json(response, 200, { members: groups.members(groupMemberMatch[1], actor) });
        if (groupMemberMatch && groups && request.method === 'POST') return json(response, 201, groups.addMember(groupMemberMatch[1], await readJson(request), actor));
        const tokenMatch = /^\/api\/v1\/users\/([0-9a-f-]+)\/tokens$/.exec(url.pathname);
        if (tokenMatch && request.method === 'POST') return json(response, 201, authentication.createToken(tokenMatch[1], actor));
        const passwordMatch = /^\/api\/v1\/users\/([0-9a-f-]+)\/password$/.exec(url.pathname);
        if (passwordMatch && request.method === 'PUT' && identity) { const body = await readJson(request); return json(response, 200, await identity.setPassword(passwordMatch[1], body.password, actor)); }
        const passwordResetMatch = /^\/api\/v1\/users\/([0-9a-f-]+)\/password-reset$/.exec(url.pathname);
        if (passwordResetMatch && request.method === 'POST' && identity) return json(response, 201, identity.createPasswordReset(passwordResetMatch[1], actor));
        const sshKeyCollectionMatch = /^\/api\/v1\/users\/([0-9a-f-]+)\/ssh-keys$/.exec(url.pathname);
        if (sshKeyCollectionMatch && sshKeys && request.method === 'GET') return json(response, 200, { sshKeys: sshKeys.list(sshKeyCollectionMatch[1], actor) });
        if (sshKeyCollectionMatch && sshKeys && request.method === 'POST') return json(response, 201, sshKeys.create(sshKeyCollectionMatch[1], await readJson(request), actor));
        const sshKeyMatch = /^\/api\/v1\/users\/([0-9a-f-]+)\/ssh-keys\/([0-9a-f-]+)$/.exec(url.pathname);
        if (sshKeyMatch && sshKeys && request.method === 'DELETE') return json(response, 200, sshKeys.remove(sshKeyMatch[1], sshKeyMatch[2], actor));

        const projectMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)$/.exec(url.pathname);
        if (projectMatch && request.method === 'GET') { authentication.requireProject(projectMatch[1], actor, 'guest'); return json(response, 200, await projects.detail(projectMatch[1])); }
        const collaborationMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/collaboration-ref$/.exec(url.pathname);
        if (collaborationMatch && collaborationRefs && request.method === 'GET') { authentication.requireProject(collaborationMatch[1], actor, 'guest'); return json(response, 200, await collaborationRefs.read(collaborationMatch[1])); }
        if (collaborationMatch && collaborationRefs && request.method === 'POST') { authentication.requireProject(collaborationMatch[1], actor, 'maintainer'); return json(response, 201, await collaborationRefs.publish(collaborationMatch[1], actor.username)); }
        const collaborationImportMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/collaboration-ref\/import$/.exec(url.pathname);
        if (collaborationImportMatch && collaborationRefs && request.method === 'POST') { authentication.requireProject(collaborationImportMatch[1], actor, 'owner'); return json(response, 200, collaborationRefs.import(collaborationImportMatch[1], await readJson(request, 20 * 1024 * 1024), actor.username)); }
        const forgeCollectionMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/forge-mesh\/remotes$/.exec(url.pathname);
        if (forgeCollectionMatch && forgeMesh && request.method === 'GET') { authentication.requireProject(forgeCollectionMatch[1], actor, 'guest'); return json(response, 200, { remotes: forgeMesh.list(forgeCollectionMatch[1]) }); }
        if (forgeCollectionMatch && forgeMesh && request.method === 'POST') { authentication.requireProject(forgeCollectionMatch[1], actor, 'owner'); return json(response, 201, forgeMesh.add(forgeCollectionMatch[1], await readJson(request), actor.username)); }
        const forgeRemoteMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/forge-mesh\/remotes\/([0-9a-f-]+)$/.exec(url.pathname);
        if (forgeRemoteMatch && forgeMesh && request.method === 'DELETE') { authentication.requireProject(forgeRemoteMatch[1], actor, 'owner'); return json(response, 200, forgeMesh.remove(forgeRemoteMatch[1], forgeRemoteMatch[2], actor.username)); }
        const forgeSyncMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/forge-mesh\/remotes\/([0-9a-f-]+)\/sync$/.exec(url.pathname);
        if (forgeSyncMatch && forgeMesh && request.method === 'POST') { authentication.requireProject(forgeSyncMatch[1], actor, 'maintainer'); return json(response, 200, await forgeMesh.sync(forgeSyncMatch[1], forgeSyncMatch[2], actor.username)); }
        const forgeResolveMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/forge-mesh\/remotes\/([0-9a-f-]+)\/conflicts\/([0-9a-f-]+)\/resolve$/.exec(url.pathname);
        if (forgeResolveMatch && forgeMesh && request.method === 'POST') { authentication.requireProject(forgeResolveMatch[1], actor, 'maintainer'); const body = await readJson(request); return json(response, 200, await forgeMesh.resolve(forgeResolveMatch[1], forgeResolveMatch[2], forgeResolveMatch[3], body.resolution, actor.username)); }
        const dependencyMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/dependencies$/.exec(url.pathname);
        if (dependencyMatch && changeIntelligence && request.method === 'GET') { authentication.requireProject(dependencyMatch[1], actor, 'guest'); return json(response, 200, { dependencies: changeIntelligence.links(dependencyMatch[1]) }); }
        if (dependencyMatch && changeIntelligence && request.method === 'POST') { authentication.requireProject(dependencyMatch[1], actor, 'owner'); return json(response, 201, changeIntelligence.addLink(dependencyMatch[1], await readJson(request), actor.username)); }
        const impactMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/impact$/.exec(url.pathname);
        if (impactMatch && changeIntelligence && request.method === 'GET') { authentication.requireProject(impactMatch[1], actor, 'guest'); return json(response, 200, await changeIntelligence.impact(impactMatch[1], Number(impactMatch[2]))); }
        const reviewerSuggestionMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/reviewers\/suggest$/.exec(url.pathname);
        if (reviewerSuggestionMatch && attention && request.method === 'GET') { authentication.requireProject(reviewerSuggestionMatch[1], actor, 'developer'); return json(response, 200, await attention.reviewerSuggestions(reviewerSuggestionMatch[1], Number(reviewerSuggestionMatch[2]))); }
        const mirrorMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/mirror\/sync$/.exec(url.pathname);
        if (mirrorMatch && request.method === 'POST') { authentication.requireProject(mirrorMatch[1], actor, 'maintainer'); const item = mirrors ? await mirrors.sync(mirrorMatch[1], actor.username) : await projects.sync(mirrorMatch[1], actor.username); emitEvent(mirrorMatch[1], 'mirror.synced', item); return json(response, 200, item); }
        const mirrorConflictMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/mirror\/conflicts$/.exec(url.pathname);
        if (mirrorConflictMatch && mirrors && request.method === 'GET') { authentication.requireProject(mirrorConflictMatch[1], actor, 'maintainer'); return json(response, 200, { conflicts: mirrors.conflicts(mirrorConflictMatch[1]) }); }
        const mirrorResolveMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/mirror\/conflicts\/([0-9a-f-]+)\/resolve$/.exec(url.pathname);
        if (mirrorResolveMatch && mirrors && request.method === 'POST') { authentication.requireProject(mirrorResolveMatch[1], actor, 'maintainer'); const body = await readJson(request); return json(response, 200, await mirrors.resolveConflict(mirrorResolveMatch[1], mirrorResolveMatch[2], body.resolution, actor.username)); }
        const exportMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/export$/.exec(url.pathname);
        if (exportMatch && mirrors && request.method === 'GET') { authentication.requireProject(exportMatch[1], actor, 'owner'); return json(response, 200, mirrors.exportManifest(exportMatch[1])); }
        const issueMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/issues$/.exec(url.pathname);
        if (issueMatch && request.method === 'GET' && workItems) { authentication.requireProject(issueMatch[1], actor, 'guest'); return json(response, 200, { issues: workItems.listIssues(issueMatch[1]) }); }
        if (issueMatch && request.method === 'POST' && workItems) { authentication.requireProject(issueMatch[1], actor, 'developer'); const item = workItems.createIssue(issueMatch[1], await readJson(request), actor.username); emitEvent(issueMatch[1], 'issue.created', item, actor); return json(response, 201, item); }
        const issueItemMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/issues\/(\d+)$/.exec(url.pathname);
        if (issueItemMatch && request.method === 'PATCH' && workItems) { authentication.requireProject(issueItemMatch[1], actor, 'developer'); const item = workItems.updateIssue(issueItemMatch[1], Number(issueItemMatch[2]), await readJson(request), actor.username); emitEvent(issueItemMatch[1], 'issue.updated', item); return json(response, 200, item); }
        const mergeRequestMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests$/.exec(url.pathname);
        if (mergeRequestMatch && request.method === 'GET' && workItems) { authentication.requireProject(mergeRequestMatch[1], actor, 'guest'); return json(response, 200, { mergeRequests: workItems.listMergeRequests(mergeRequestMatch[1]) }); }
        if (mergeRequestMatch && request.method === 'POST' && workItems) { authentication.requireProject(mergeRequestMatch[1], actor, 'developer'); const item = workItems.createMergeRequest(mergeRequestMatch[1], await readJson(request), actor.username); emitEvent(mergeRequestMatch[1], 'merge_request.created', item, actor); return json(response, 201, item); }
        const changeGraphMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/graph$/.exec(url.pathname);
        if (changeGraphMatch && request.method === 'GET' && workItems) { authentication.requireProject(changeGraphMatch[1], actor, 'guest'); return json(response, 200, workItems.changeGraph(changeGraphMatch[1])); }
        const semanticDiffMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/semantic-diff$/.exec(url.pathname);
        if (semanticDiffMatch && request.method === 'GET' && reviews) { authentication.requireProject(semanticDiffMatch[1], actor, 'guest'); return json(response, 200, await reviews.semanticDiff(semanticDiffMatch[1], Number(semanticDiffMatch[2]))); }
        const queueMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-queue$/.exec(url.pathname);
        if (queueMatch && mergeQueue && request.method === 'GET') { authentication.requireProject(queueMatch[1], actor, 'guest'); return json(response, 200, { entries: mergeQueue.list(queueMatch[1]) }); }
        if (queueMatch && mergeQueue && request.method === 'POST') { authentication.requireProject(queueMatch[1], actor, 'developer'); const body = await readJson(request); return json(response, 201, mergeQueue.enqueue(queueMatch[1], Number(body.mergeRequestIid), actor.username)); }
        const queueProcessMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-queue\/process$/.exec(url.pathname);
        if (queueProcessMatch && mergeQueue && request.method === 'POST') { authentication.requireProject(queueProcessMatch[1], actor, 'maintainer'); return json(response, 200, await mergeQueue.process(queueProcessMatch[1])); }
        const approvalMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/approve$/.exec(url.pathname);
        if (approvalMatch && request.method === 'POST' && workItems) { authentication.requireProject(approvalMatch[1], actor, 'developer'); const item = await workItems.approveMergeRequest(approvalMatch[1], Number(approvalMatch[2]), actor.username); emitEvent(approvalMatch[1], 'merge_request.approved', item); return json(response, 200, item); }
        const mergeMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/merge$/.exec(url.pathname);
        if (mergeMatch && request.method === 'POST' && workItems) { authentication.requireProject(mergeMatch[1], actor, 'maintainer'); const item = await workItems.mergeMergeRequest(mergeMatch[1], Number(mergeMatch[2]), actor.username); emitEvent(mergeMatch[1], 'merge_request.merged', item); return json(response, 200, item); }
        const threadMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/threads$/.exec(url.pathname);
        if (threadMatch && request.method === 'GET' && workItems) { authentication.requireProject(threadMatch[1], actor, 'guest'); return json(response, 200, { threads: workItems.reviewThreads(threadMatch[1], Number(threadMatch[2])) }); }
        if (threadMatch && request.method === 'POST' && workItems) { authentication.requireProject(threadMatch[1], actor, 'developer'); return json(response, 201, workItems.createReviewThread(threadMatch[1], Number(threadMatch[2]), await readJson(request), actor.username)); }
        const threadReplyMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/threads\/([0-9a-f-]+)\/replies$/.exec(url.pathname);
        if (threadReplyMatch && request.method === 'POST' && workItems) { authentication.requireProject(threadReplyMatch[1], actor, 'developer'); return json(response, 201, workItems.replyReviewThread(threadReplyMatch[1], Number(threadReplyMatch[2]), threadReplyMatch[3], await readJson(request), actor.username)); }
        const threadResolveMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/threads\/([0-9a-f-]+)\/resolve$/.exec(url.pathname);
        if (threadResolveMatch && request.method === 'POST' && workItems) { authentication.requireProject(threadResolveMatch[1], actor, 'developer'); const body = await readJson(request); return json(response, 200, workItems.resolveReviewThread(threadResolveMatch[1], Number(threadResolveMatch[2]), threadResolveMatch[3], body.resolved !== false, actor.username)); }
        const protectedMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/protected-branches$/.exec(url.pathname);
        if (protectedMatch && request.method === 'GET') { authentication.requireProject(protectedMatch[1], actor, 'guest'); return json(response, 200, { protectedBranches: projects.protectedBranches(protectedMatch[1]) }); }
        if (protectedMatch && request.method === 'POST') { authentication.requireProject(protectedMatch[1], actor, 'maintainer'); return json(response, 201, projects.protectBranch(protectedMatch[1], await readJson(request), actor.username)); }
        const rulesetMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/rulesets$/.exec(url.pathname);
        if (rulesetMatch && policy && request.method === 'GET') { authentication.requireProject(rulesetMatch[1], actor, 'guest'); return json(response, 200, { rulesets: policy.listRulesets(rulesetMatch[1]) }); }
        if (rulesetMatch && policy && request.method === 'POST') { authentication.requireProject(rulesetMatch[1], actor, 'owner'); return json(response, 201, policy.saveRuleset(rulesetMatch[1], await readJson(request), actor.username)); }
        const explainMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/permissions\/explain$/.exec(url.pathname);
        if (explainMatch && policy && request.method === 'GET') { const userId = url.searchParams.get('userId') || actor.id; if (userId !== actor.id) authentication.requireProject(explainMatch[1], actor, 'owner'); return json(response, 200, policy.explain(explainMatch[1], userId, url.searchParams.get('required') || 'guest')); }
        const simulateMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/policies\/simulate$/.exec(url.pathname);
        if (simulateMatch && policy && request.method === 'POST') { authentication.requireProject(simulateMatch[1], actor, 'owner'); return json(response, 200, await policy.simulate(simulateMatch[1], await readJson(request))); }
        const forecastMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/policies\/forecast$/.exec(url.pathname);
        if (forecastMatch && policy && request.method === 'GET') { authentication.requireProject(forecastMatch[1], actor, 'owner'); return json(response, 200, { changes: policy.forecast(forecastMatch[1], url.searchParams.get('days')) }); }
        const evidenceCollectionMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/policy-evidence$/.exec(url.pathname);
        if (evidenceCollectionMatch && policyEvidence && request.method === 'GET') { authentication.requireProject(evidenceCollectionMatch[1], actor, 'owner'); return json(response, 200, { bundles: policyEvidence.list(evidenceCollectionMatch[1]) }); }
        if (evidenceCollectionMatch && policyEvidence && request.method === 'POST') { authentication.requireProject(evidenceCollectionMatch[1], actor, 'maintainer'); return json(response, 201, await policyEvidence.create(evidenceCollectionMatch[1], await readJson(request), actor.username)); }
        const evidenceMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/policy-evidence\/([0-9a-f-]+)$/.exec(url.pathname);
        if (evidenceMatch && policyEvidence && request.method === 'GET') { authentication.requireProject(evidenceMatch[1], actor, 'owner'); return json(response, 200, policyEvidence.get(evidenceMatch[1], evidenceMatch[2])); }
        const bundleCollectionMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/change-bundles$/.exec(url.pathname);
        if (bundleCollectionMatch && changeBundles && request.method === 'GET') { authentication.requireProject(bundleCollectionMatch[1], actor, 'guest'); return json(response, 200, { bundles: changeBundles.list(bundleCollectionMatch[1]) }); }
        if (bundleCollectionMatch && changeBundles && request.method === 'POST') { authentication.requireProject(bundleCollectionMatch[1], actor, 'developer'); const body = await readJson(request); return json(response, 201, await changeBundles.create(bundleCollectionMatch[1], Number(body.mergeRequestIid), actor.username)); }
        const bundleDownloadMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/change-bundles\/([0-9a-f-]+)\/download$/.exec(url.pathname);
        if (bundleDownloadMatch && changeBundles && request.method === 'GET') { authentication.requireProject(bundleDownloadMatch[1], actor, 'guest'); const result = changeBundles.read(bundleDownloadMatch[1], bundleDownloadMatch[2]); return binary(response, 200, result.content, 'application/vnd.kitsune.change-bundle+json', `${result.item.id}.kcb`); }
        const bundleImportMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/change-bundles\/import$/.exec(url.pathname);
        if (bundleImportMatch && changeBundles && request.method === 'POST') { authentication.requireProject(bundleImportMatch[1], actor, 'maintainer'); return json(response, 201, await changeBundles.import(bundleImportMatch[1], await readJson(request, 90 * 1024 * 1024), actor.username)); }
        const gateProviderMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/quality-gates$/.exec(url.pathname);
        if (gateProviderMatch && qualityGates && request.method === 'GET') { authentication.requireProject(gateProviderMatch[1], actor, 'guest'); return json(response, 200, { providers: qualityGates.listProviders(gateProviderMatch[1]) }); }
        if (gateProviderMatch && qualityGates && request.method === 'POST') { authentication.requireProject(gateProviderMatch[1], actor, 'owner'); return json(response, 201, qualityGates.createProvider(gateProviderMatch[1], await readJson(request), actor.username)); }
        const gateRequestMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/quality-gates\/request$/.exec(url.pathname);
        if (gateRequestMatch && qualityGates && request.method === 'POST') { authentication.requireProject(gateRequestMatch[1], actor, 'developer'); return json(response, 202, await qualityGates.request(gateRequestMatch[1], Number(gateRequestMatch[2]), actor.username)); }
        const gateStatusMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/quality-gates$/.exec(url.pathname);
        if (gateStatusMatch && qualityGates && request.method === 'GET') { authentication.requireProject(gateStatusMatch[1], actor, 'guest'); return json(response, 200, { statuses: qualityGates.statuses(gateStatusMatch[1], Number(gateStatusMatch[2])) }); }
        const previewCollectionMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/previews$/.exec(url.pathname);
        if (previewCollectionMatch && previews && request.method === 'GET') { authentication.requireProject(previewCollectionMatch[1], actor, 'guest'); return json(response, 200, { previews: previews.list(previewCollectionMatch[1]), enabled: previews.enabled() }); }
        const previewCreateMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/previews$/.exec(url.pathname);
        if (previewCreateMatch && previews && request.method === 'POST') { authentication.requireProject(previewCreateMatch[1], actor, 'maintainer'); return json(response, 201, await previews.create(previewCreateMatch[1], Number(previewCreateMatch[2]), await readJson(request), actor.username)); }
        const previewMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/previews\/([0-9a-f-]+)$/.exec(url.pathname);
        if (previewMatch && previews && request.method === 'DELETE') { authentication.requireProject(previewMatch[1], actor, 'maintainer'); return json(response, 200, await previews.remove(previewMatch[1], previewMatch[2], actor.username)); }
        const aiSettingsMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/ai$/.exec(url.pathname);
        if (aiSettingsMatch && ai && request.method === 'GET') { authentication.requireProject(aiSettingsMatch[1], actor, 'guest'); return json(response, 200, ai.capability(aiSettingsMatch[1])); }
        if (aiSettingsMatch && ai && request.method === 'PUT') { authentication.requireProject(aiSettingsMatch[1], actor, 'owner'); return json(response, 200, ai.setPolicy(aiSettingsMatch[1], await readJson(request), actor.username)); }
        const aiRunsMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/ai\/runs$/.exec(url.pathname);
        if (aiRunsMatch && ai && request.method === 'GET') { authentication.requireProject(aiRunsMatch[1], actor, 'owner'); return json(response, 200, { runs: ai.runs(aiRunsMatch[1]) }); }
        const aiSummaryMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/merge-requests\/(\d+)\/ai\/summary$/.exec(url.pathname);
        if (aiSummaryMatch && ai && request.method === 'POST') { authentication.requireProject(aiSummaryMatch[1], actor, 'developer'); return json(response, 200, await ai.summarizeMergeRequest(aiSummaryMatch[1], Number(aiSummaryMatch[2]), await readJson(request), actor.username)); }
        const storageMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/storage$/.exec(url.pathname);
        if (storageMatch && quota && request.method === 'GET') { authentication.requireProject(storageMatch[1], actor, 'guest'); return json(response, 200, quota.usage(storageMatch[1])); }
        if (storageMatch && quota && request.method === 'PUT') { authentication.requireProject(storageMatch[1], actor, 'owner'); const updated = projects.setStorageLimit(storageMatch[1], await readJson(request), actor.username); return json(response, 200, { project: updated, storage: quota.usage(storageMatch[1]) }); }
        const packageCollectionMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/packages$/.exec(url.pathname);
        if (packageCollectionMatch && packages && request.method === 'GET') { authentication.requireProject(packageCollectionMatch[1], actor, 'guest'); return json(response, 200, { packages: packages.list(packageCollectionMatch[1]) }); }
        const packageMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/packages\/([0-9a-f-]+)$/.exec(url.pathname);
        if (packageMatch && packages && request.method === 'DELETE') { authentication.requireProject(packageMatch[1], actor, 'maintainer'); return json(response, 200, packages.remove(packageMatch[1], packageMatch[2], actor.username)); }
        const boardCollectionMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/boards$/.exec(url.pathname);
        if (boardCollectionMatch && boards && request.method === 'GET') { authentication.requireProject(boardCollectionMatch[1], actor, 'guest'); return json(response, 200, { boards: boards.list(boardCollectionMatch[1]) }); }
        if (boardCollectionMatch && boards && request.method === 'POST') { authentication.requireProject(boardCollectionMatch[1], actor, 'developer'); return json(response, 201, boards.create(boardCollectionMatch[1], await readJson(request), actor.username)); }
        const boardMoveMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/boards\/([0-9a-f-]+)\/issues\/(\d+)\/move$/.exec(url.pathname);
        if (boardMoveMatch && boards && request.method === 'POST') { authentication.requireProject(boardMoveMatch[1], actor, 'developer'); const body = await readJson(request); return json(response, 200, boards.move(boardMoveMatch[1], boardMoveMatch[2], Number(boardMoveMatch[3]), body.listId, actor.username)); }
        const contentMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/(releases|wiki|snippets|milestones)$/.exec(url.pathname);
        if (contentMatch && content) {
          const collections = { releases: 'releases', wiki: 'wikiPages', snippets: 'snippets', milestones: 'milestones' };
          if (request.method === 'GET') { authentication.requireProject(contentMatch[1], actor, 'guest'); return json(response, 200, { [collections[contentMatch[2]]]: content.list(contentMatch[1], collections[contentMatch[2]]) }); }
          if (request.method === 'POST') {
            authentication.requireProject(contentMatch[1], actor, contentMatch[2] === 'releases' ? 'maintainer' : 'developer');
            const body = await readJson(request);
            const creators = { releases: 'createRelease', wiki: 'saveWikiPage', snippets: 'createSnippet', milestones: 'createMilestone' };
            const item = await content[creators[contentMatch[2]]](contentMatch[1], body, actor.username);
            if (contentMatch[2] === 'releases') emitEvent(contentMatch[1], 'release.created', item, actor);
            return json(response, 201, item);
          }
        }
        const memberMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/members$/.exec(url.pathname);
        if (memberMatch && request.method === 'GET') return json(response, 200, { members: authentication.members(memberMatch[1], actor) });
        if (memberMatch && request.method === 'POST') return json(response, 201, authentication.addMember(memberMatch[1], await readJson(request), actor));
        const webhookMatch = /^\/api\/v1\/projects\/([0-9a-f-]+)\/webhooks$/.exec(url.pathname);
        if (webhookMatch && webhooks && request.method === 'GET') { authentication.requireProject(webhookMatch[1], actor, 'owner'); return json(response, 200, webhooks.list(webhookMatch[1])); }
        if (webhookMatch && webhooks && request.method === 'POST') { authentication.requireProject(webhookMatch[1], actor, 'owner'); return json(response, 201, webhooks.create(webhookMatch[1], await readJson(request), actor.username)); }
        return json(response, 404, { error: 'API route not found', requestId });
      }

      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = path.resolve(publicPath, relative);
      if (!file.startsWith(`${path.resolve(publicPath)}${path.sep}`) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
        return json(response, 404, { error: 'Not found', requestId });
      }
      const fileContent = fs.readFileSync(file);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': fileContent.length,
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      response.end(fileContent);
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) console.error(`[${requestId}]`, error.message);
      json(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Internal server error', requestId });
    }
  });
}

module.exports = { createApp, readJson, readText, secureEqual };
