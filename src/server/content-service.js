const crypto = require('node:crypto');
const { slug, text } = require('./validation');

class ContentService {
  constructor({ store, projects }) { this.store = store; this.projects = projects; }

  list(projectId, collection) {
    this.projects.get(projectId);
    return this.store.snapshot()[collection].filter(item => item.projectId === projectId);
  }

  async createRelease(projectId, input, actor) {
    const project = this.projects.get(projectId);
    const tag = text(input.tag, 'Release tag', { max: 1024, required: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag) || tag.includes('..')) throw new Error('Release tag is invalid');
    await this.projects.repositories.run(['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: this.projects.repositories.pathFor(project) });
    const release = { id: crypto.randomUUID(), projectId, tag, name: text(input.name || tag, 'Release name', { max: 500, required: true }), description: text(input.description, 'Release description', { max: 100_000 }), assets: Array.isArray(input.assets) ? input.assets.slice(0, 50).map(asset => ({ name: text(asset.name, 'Asset name', { max: 256, required: true }), url: this._url(asset.url) })) : [], author: actor, createdAt: new Date().toISOString() };
    return this.store.update(state => { if (state.releases.some(item => item.projectId === projectId && item.tag === tag)) throw Object.assign(new Error('Release already exists'), { statusCode: 409 }); state.releases.push(release); return release; }, { actor, action: 'release.create', target: release.id });
  }

  saveWikiPage(projectId, input, actor) {
    this.projects.get(projectId);
    const pageSlug = slug(String(input.slug || input.title || '').replace(/\s+/g, '-'), 'Wiki page slug');
    const now = new Date().toISOString();
    return this.store.update(state => {
      let page = state.wikiPages.find(item => item.projectId === projectId && item.slug === pageSlug);
      const revision = { id: crypto.randomUUID(), content: text(input.content, 'Wiki content', { max: 500_000 }), author: actor, createdAt: now };
      if (page) { page.title = text(input.title || page.title, 'Wiki title', { max: 500, required: true }); page.revisions.push(revision); page.revisions = page.revisions.slice(-100); page.updatedAt = now; }
      else { page = { id: crypto.randomUUID(), projectId, slug: pageSlug, title: text(input.title || pageSlug, 'Wiki title', { max: 500, required: true }), revisions: [revision], createdAt: now, updatedAt: now }; state.wikiPages.push(page); }
      return page;
    }, { actor, action: 'wiki.save', target: `${projectId}:${pageSlug}` });
  }

  createSnippet(projectId, input, actor) {
    this.projects.get(projectId);
    const snippet = { id: crypto.randomUUID(), projectId, title: text(input.title, 'Snippet title', { max: 500, required: true }), fileName: text(input.fileName, 'Snippet file name', { max: 256, required: true }), content: text(input.content, 'Snippet content', { max: 1024 * 1024 }), visibility: ['private', 'internal', 'public'].includes(input.visibility) ? input.visibility : 'private', author: actor, createdAt: new Date().toISOString() };
    return this.store.update(state => { state.snippets.push(snippet); return snippet; }, { actor, action: 'snippet.create', target: snippet.id });
  }

  createMilestone(projectId, input, actor) {
    this.projects.get(projectId);
    const dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) throw new Error('Milestone due date is invalid');
    const milestone = { id: crypto.randomUUID(), projectId, title: text(input.title, 'Milestone title', { max: 500, required: true }), description: text(input.description, 'Milestone description', { max: 100_000 }), dueDate: dueDate?.toISOString() || null, state: 'active', author: actor, createdAt: new Date().toISOString() };
    return this.store.update(state => { state.milestones.push(milestone); return milestone; }, { actor, action: 'milestone.create', target: milestone.id });
  }

  _url(value) {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Release asset URL must use HTTPS');
    return parsed.href;
  }
}

module.exports = { ContentService };
