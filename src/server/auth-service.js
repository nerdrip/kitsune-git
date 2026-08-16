const crypto = require('node:crypto');
const { slug, text } = require('./validation');

const ROLE_LEVEL = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 };
function activeMembership(item, now = Date.now()) { return Boolean(item && (!item.expiresAt || Date.parse(item.expiresAt) > now)); }
function expiration(value) { if (value === undefined || value === null || value === '') return null; const parsed = Date.parse(value); if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed > Date.now() + 366 * 86400_000) throw new Error('Membership expiration must be within the next 366 days'); return new Date(parsed).toISOString(); }

function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function cookie(request, name) { const header = String(request.headers.cookie || ''); for (const part of header.split(';')) { const separator = part.indexOf('='); if (separator > 0 && part.slice(0, separator).trim() === name) { try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; } } } return ''; }

class AuthService {
  constructor({ store, adminToken }) {
    this.store = store;
    this.adminHash = tokenHash(adminToken);
  }

  authenticate(request) {
    const header = request.headers.authorization || '';
    let token = '';
    if (header.startsWith('Bearer ')) token = header.slice(7);
    else if (header.startsWith('Basic ')) {
      try { const value = Buffer.from(header.slice(6), 'base64').toString('utf8'); token = value.slice(value.indexOf(':') + 1); } catch { token = ''; }
    }
    if (!token) {
      const sessionToken = cookie(request, 'kitsune_session');
      if (!sessionToken) return null;
      const hash = tokenHash(sessionToken); const state = this.store.snapshot();
      const session = state.sessions.find(item => item.tokenHash === hash && Date.parse(item.expiresAt) > Date.now());
      const user = session && state.users.find(item => item.id === session.userId && !item.blocked);
      return user ? { id: user.id, username: user.username, name: user.name, admin: Boolean(user.admin), authMethod: 'session', sessionId: session.id, csrfToken: session.csrfToken } : null;
    }
    const hash = tokenHash(token);
    if (crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.adminHash))) return { id: 'root', username: 'administrator', admin: true };
    const user = this.store.snapshot().users.find(item => (item.tokenHashes || []).some(value => value === hash) && !item.blocked);
    if (user) return { id: user.id, username: user.username, name: user.name, admin: Boolean(user.admin) };
    return null;
  }

  listUsers() {
    return this.store.snapshot().users.map(({ tokenHashes, passwordHash, totpSecret, ...user }) => ({ ...user, tokenCount: tokenHashes?.length || 0, passwordEnabled: Boolean(passwordHash), totpEnabled: Boolean(totpSecret), passkeyCount: this.store.snapshot().passkeys.filter(item => item.userId === user.id).length }));
  }

  createUser(input, actor) {
    this.requireAdmin(actor);
    const username = slug(input.username, 'Username');
    if (this.store.snapshot().users.some(user => user.username === username)) throw Object.assign(new Error('Username already exists'), { statusCode: 409 });
    const rawToken = `kgl_${crypto.randomBytes(32).toString('base64url')}`;
    const userEmail = input.email ? String(input.email).trim().toLowerCase() : null;
    if (userEmail && (userEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail))) throw new Error('Email address is invalid');
    if (userEmail && this.store.snapshot().users.some(user => user.email === userEmail)) throw Object.assign(new Error('Email address already exists'), { statusCode: 409 });
    const user = { id: crypto.randomUUID(), username, email: userEmail, emailVerifiedAt: null, name: text(input.name || username, 'Name', { max: 256, required: true }), admin: Boolean(input.admin), blocked: false, tokenHashes: [tokenHash(rawToken)], createdAt: new Date().toISOString() };
    const saved = this.store.update(state => { state.users.push(user); return user; }, { actor: actor.username, action: 'user.create', target: user.id });
    const { tokenHashes, ...publicUser } = saved;
    return { user: { ...publicUser, tokenCount: 1 }, token: rawToken };
  }

  createToken(userId, actor) {
    if (!actor?.admin && actor?.id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const rawToken = `kgl_${crypto.randomBytes(32).toString('base64url')}`;
    this.store.update(state => {
      const user = state.users.find(item => item.id === userId);
      if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
      user.tokenHashes = [...(user.tokenHashes || []), tokenHash(rawToken)].slice(-20);
      return user;
    }, { actor: actor.username, action: 'token.create', target: userId });
    return { token: rawToken };
  }

  addMember(projectId, input, actor) {
    this.requireProject(projectId, actor, 'owner');
    const user = this.store.snapshot().users.find(item => item.id === input.userId);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    const role = String(input.role || 'developer');
    if (!ROLE_LEVEL[role]) throw new Error('Project role is invalid');
    const expiresAt = expiration(input.expiresAt);
    return this.store.update(state => {
      const existing = state.memberships.find(item => item.projectId === projectId && item.userId === user.id);
      if (existing) { existing.role = role; existing.expiresAt = expiresAt; }
      else state.memberships.push({ projectId, userId: user.id, role, expiresAt, createdAt: new Date().toISOString() });
      return { projectId, userId: user.id, username: user.username, role, expiresAt };
    }, { actor: actor.username, action: 'member.upsert', target: `${projectId}:${user.id}` });
  }

  grantOwner(projectId, userId) {
    if (!userId || userId === 'root') return;
    this.store.update(state => {
      if (!state.memberships.some(item => item.projectId === projectId && item.userId === userId)) {
        state.memberships.push({ projectId, userId, role: 'owner', createdAt: new Date().toISOString() });
      }
      return null;
    });
  }

  members(projectId, actor) {
    this.requireProject(projectId, actor, 'guest');
    const state = this.store.snapshot();
    return state.memberships.filter(item => item.projectId === projectId).map(item => ({ ...item, username: state.users.find(user => user.id === item.userId)?.username || 'unknown' }));
  }

  canProject(project, actor, required = 'guest') {
    if (actor?.admin) return true;
    if (required === 'guest' && project.visibility === 'public') return true;
    const state = this.store.snapshot();
    const membership = actor && state.memberships.find(item => item.projectId === project.id && item.userId === actor.id && activeMembership(item));
    let best = membership?.role || null;
    let group = project.groupId ? state.groups.find(item => item.id === project.groupId) : null;
    const seen = new Set();
    while (actor && group && !seen.has(group.id)) {
      seen.add(group.id);
      const inherited = state.groupMemberships.find(item => item.groupId === group.id && item.userId === actor.id && activeMembership(item))?.role;
      if (inherited && (!best || ROLE_LEVEL[inherited] > ROLE_LEVEL[best])) best = inherited;
      group = group.parentId ? state.groups.find(item => item.id === group.parentId) : null;
    }
    return Boolean(best && ROLE_LEVEL[best] >= ROLE_LEVEL[required]);
  }

  requireProject(projectId, actor, required) {
    const project = this.store.snapshot().projects.find(item => item.id === projectId);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    if (!this.canProject(project, actor, required)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return project;
  }

  requireAdmin(actor) {
    if (!actor?.admin) throw Object.assign(new Error('Administrator access required'), { statusCode: 403 });
  }

  requireCsrf(request, actor) {
    if (actor?.authMethod !== 'session' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const supplied = String(request.headers['x-csrf-token'] || '');
    const expected = String(actor.csrfToken || '');
    if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw Object.assign(new Error('CSRF token is invalid'), { statusCode: 403 });
  }
}

module.exports = { AuthService, ROLE_LEVEL, tokenHash, cookie, activeMembership, expiration };
