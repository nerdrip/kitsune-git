const crypto = require('node:crypto');
const { slug, text, visibility } = require('./validation');
const { ROLE_LEVEL, activeMembership, expiration } = require('./auth-service');

class GroupService {
  constructor({ store }) { this.store = store; }

  get(id) {
    const group = this.store.snapshot().groups.find(item => item.id === id);
    if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
    return group;
  }

  list(actor) {
    const state = this.store.snapshot();
    return state.groups.filter(group => group.visibility === 'public' || actor?.admin || this.role(group.id, actor?.id, state));
  }

  role(groupId, userId, state = this.store.snapshot()) {
    if (!userId) return null;
    let current = state.groups.find(item => item.id === groupId);
    let best = null;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const membership = state.groupMemberships.find(item => item.groupId === current.id && item.userId === userId && activeMembership(item));
      if (membership && (!best || ROLE_LEVEL[membership.role] > ROLE_LEVEL[best])) best = membership.role;
      current = current.parentId ? state.groups.find(item => item.id === current.parentId) : null;
    }
    return best;
  }

  require(groupId, actor, required = 'guest') {
    const group = this.get(groupId);
    if (actor?.admin || (required === 'guest' && group.visibility === 'public')) return group;
    const role = this.role(groupId, actor?.id);
    if (!role || ROLE_LEVEL[role] < ROLE_LEVEL[required]) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return group;
  }

  create(input, actor) {
    const parentId = input.parentId || null;
    const parent = parentId ? this.require(parentId, actor, 'owner') : null;
    const generated = String(input.slug || input.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    const groupSlug = slug(generated, 'Group slug');
    const fullPath = parent ? `${parent.fullPath}/${groupSlug}` : groupSlug;
    if (this.store.snapshot().groups.some(item => item.fullPath === fullPath)) throw Object.assign(new Error('Group path already exists'), { statusCode: 409 });
    const group = { id: crypto.randomUUID(), parentId, slug: groupSlug, fullPath, name: text(input.name || groupSlug, 'Group name', { max: 256, required: true }), description: text(input.description, 'Group description', { max: 10_000 }), visibility: visibility(input.visibility), createdAt: new Date().toISOString() };
    return this.store.update(state => {
      state.groups.push(group);
      if (!actor.admin) state.groupMemberships.push({ groupId: group.id, userId: actor.id, role: 'owner', createdAt: group.createdAt });
      return group;
    }, { actor: actor.username, action: 'group.create', target: group.id });
  }

  members(groupId, actor) {
    this.require(groupId, actor, 'guest');
    const state = this.store.snapshot();
    return state.groupMemberships.filter(item => item.groupId === groupId).map(item => ({ ...item, username: state.users.find(user => user.id === item.userId)?.username || 'unknown' }));
  }

  addMember(groupId, input, actor) {
    this.require(groupId, actor, 'owner');
    const role = String(input.role || 'developer');
    if (!ROLE_LEVEL[role]) throw new Error('Group role is invalid');
    const user = this.store.snapshot().users.find(item => item.id === input.userId);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    const expiresAt = expiration(input.expiresAt);
    return this.store.update(state => {
      const existing = state.groupMemberships.find(item => item.groupId === groupId && item.userId === user.id);
      if (existing) { existing.role = role; existing.expiresAt = expiresAt; }
      else state.groupMemberships.push({ groupId, userId: user.id, role, expiresAt, createdAt: new Date().toISOString() });
      return { groupId, userId: user.id, username: user.username, role, expiresAt };
    }, { actor: actor.username, action: 'group.member.upsert', target: `${groupId}:${user.id}` });
  }

  prepareProjectInput(input, actor) {
    if (!input.groupId) return input;
    const group = this.require(input.groupId, actor, 'developer');
    return { ...input, groupId: group.id, namespace: group.fullPath.replaceAll('/', '-') };
  }
}

module.exports = { GroupService };
