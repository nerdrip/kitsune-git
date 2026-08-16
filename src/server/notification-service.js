const crypto = require('node:crypto');

class NotificationService {
  constructor({ store }) { this.store = store; }
  emit(projectId, event, data, actor) {
    const state = this.store.snapshot();
    const project = state.projects.find(item => item.id === projectId); if (!project) return;
    const recipients = new Set(state.memberships.filter(item => item.projectId === projectId).map(item => item.userId));
    let group = project.groupId ? state.groups.find(item => item.id === project.groupId) : null;
    const seen = new Set(); while (group && !seen.has(group.id)) { seen.add(group.id); for (const item of state.groupMemberships.filter(value => value.groupId === group.id)) recipients.add(item.userId); group = group.parentId ? state.groups.find(item => item.id === group.parentId) : null; }
    for (const userId of [...recipients]) if (userId === actor?.id || !state.users.some(item => item.id === userId && !item.blocked)) recipients.delete(userId);
    if (!recipients.size) return;
    const now = new Date().toISOString();
    this.store.update(draft => { for (const userId of recipients) draft.notifications.push({ id: crypto.randomUUID(), userId, projectId, event, title: data.title || data.name || event, targetId: data.id || null, readAt: null, createdAt: now }); draft.notifications = draft.notifications.slice(-50_000); return null; });
  }
  list(actor, unreadOnly = false) { return this.store.snapshot().notifications.filter(item => item.userId === actor.id && (!unreadOnly || !item.readAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  markRead(id, actor) { return this.store.update(state => { const item = state.notifications.find(value => value.id === id && value.userId === actor.id); if (!item) throw Object.assign(new Error('Notification not found'), { statusCode: 404 }); item.readAt = new Date().toISOString(); return item; }, { actor: actor.username, action: 'notification.read', target: id }); }
}

module.exports = { NotificationService };
