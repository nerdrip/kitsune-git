const crypto = require('node:crypto');
const { slug, text, visibility, remoteUrl } = require('./validation');

class ProjectService {
  constructor({ store, repositories, providerImports = null, secretVault = null, defaultStorageLimitBytes = 0 }) {
    this.store = store;
    this.repositories = repositories;
    this.providerImports = providerImports;
    this.secretVault = secretVault;
    this.defaultStorageLimitBytes = defaultStorageLimitBytes;
    this.syncing = new Map();
  }

  _public(project) {
    if (!project) return project;
    const { mirrorCredential, ...safe } = project;
    return { ...safe, mirrorHasCredentials: Boolean(mirrorCredential) };
  }

  list() { return this.store.snapshot().projects.map(project => this._public(project)); }

  get(id) {
    const project = this.store.snapshot().projects.find(item => item.id === id);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return this._public(project);
  }

  getByPath(namespace, projectSlug) {
    const project = this.list().find(item => item.namespace === namespace && item.slug === projectSlug);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return project;
  }

  _input(input, importing = false) {
    const sourceUrl = importing ? remoteUrl(input.sourceUrl, { allowFile: this.repositories.allowFileRemotes }) : null;
    const sourceProvider = importing ? String(input.sourceProvider || 'git').toLowerCase() : null;
    if (sourceProvider && !['git', 'github', 'gitlab'].includes(sourceProvider)) throw new Error('Source provider is invalid');
    const mirrorDirection = importing && input.mirror ? String(input.mirrorDirection || 'pull') : null;
    if (mirrorDirection && !['pull', 'push', 'bidirectional'].includes(mirrorDirection)) throw new Error('Mirror direction is invalid');
    const generatedSlug = String(input.slug || input.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return {
      namespace: slug(input.namespace || 'root', 'Namespace'),
      groupId: input.groupId ? String(input.groupId) : null,
      slug: slug(generatedSlug, 'Project name'),
      name: text(input.name || input.slug, 'Project name', { max: 128, required: true }),
      description: text(input.description, 'Description', { max: 10_000 }),
      visibility: visibility(input.visibility),
      sourceUrl,
      sourceProvider,
      mirror: importing && Boolean(input.mirror),
      mirrorDirection,
      metadataMirror: importing && Boolean(input.metadataMirror ?? ['github', 'gitlab'].includes(sourceProvider)),
      mirrorIntervalMinutes: Math.max(5, Math.min(10_080, Number(input.mirrorIntervalMinutes) || 30))
    };
  }

  async create(input, actor = 'api') {
    const values = this._input(input, false);
    this._assertUnique(values.namespace, values.slug);
    const project = this._newProject(values);
    await this.repositories.create(project);
    try {
      return this.store.update(state => { state.projects.push(project); return project; }, { actor, action: 'project.create', target: project.id });
    } catch (error) {
      this.repositories.remove(project);
      throw error;
    }
  }

  async import(input, actor = 'api') {
    const values = this._input(input, true);
    this._assertUnique(values.namespace, values.slug);
    const sourceToken = String(input.sourceToken || '');
    if (sourceToken.length > 8192 || /[\0\r\n]/.test(sourceToken)) throw new Error('Provider token is invalid');
    if (sourceToken && values.mirror && !this.secretVault) throw new Error('KITSUNE_SECRET_KEY is required to store credentials for a private mirror');
    const providerData = this.providerImports ? await this.providerImports.inspect({
      provider: values.sourceProvider,
      sourceUrl: values.sourceUrl,
      token: sourceToken || null,
      apiBaseUrl: input.apiBaseUrl || null
    }) : null;
    if (providerData) {
      if (!values.description) values.description = providerData.description;
      if (!input.visibility) values.visibility = providerData.visibility;
    }
    const project = this._newProject(values);
    if (sourceToken && values.mirror) project.mirrorCredential = this.secretVault.encrypt(sourceToken);
    if (providerData) {
      project.defaultBranch = providerData.defaultBranch;
      project.topics = providerData.topics;
    }
    project.importStatus = 'running';
    await this.repositories.import(project, values.sourceUrl, sourceToken ? {
      token: sourceToken,
      username: values.sourceProvider === 'github' ? 'x-access-token' : 'oauth2'
    } : null);
    project.importStatus = 'finished';
    project.lastMirrorAt = new Date().toISOString();
    try {
      const saved = this.store.update(state => {
        state.projects.push(project);
        for (const issue of providerData?.issues || []) state.issues.push({ id: crypto.randomUUID(), projectId: project.id, ...issue });
        for (const request of providerData?.mergeRequests || []) state.mergeRequests.push({ id: crypto.randomUUID(), projectId: project.id, ...request });
        return project;
      }, { actor, action: 'project.import', target: project.id });
      return this._public(saved);
    } catch (error) {
      this.repositories.remove(project);
      throw error;
    }
  }

  _newProject(values) {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), ...values, defaultBranch: 'main', storageLimitBytes: this.defaultStorageLimitBytes, createdAt: now, updatedAt: now, lastMirrorAt: null, mirrorError: null };
  }

  _assertUnique(namespace, projectSlug) {
    if (this.list().some(item => item.namespace === namespace && item.slug === projectSlug)) {
      throw Object.assign(new Error('A project with this path already exists'), { statusCode: 409 });
    }
  }

  async sync(id, actor = 'scheduler') {
    if (this.syncing.has(id)) return this.syncing.get(id);
    const operation = this._sync(id, actor).finally(() => this.syncing.delete(id));
    this.syncing.set(id, operation);
    return operation;
  }

  async _sync(id, actor) {
    const project = this.store.snapshot().projects.find(item => item.id === id);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    if (!project.sourceUrl) throw new Error('Project has no upstream repository');
    try {
      const token = project.mirrorCredential ? this.secretVault?.decrypt(project.mirrorCredential) : null;
      const summary = token
        ? await this.repositories.sync(project, { token, username: project.sourceProvider === 'github' ? 'x-access-token' : 'oauth2' })
        : await this.repositories.sync(project);
      return this.store.update(state => {
        const current = state.projects.find(item => item.id === id);
        current.lastMirrorAt = new Date().toISOString();
        current.updatedAt = current.lastMirrorAt;
        current.mirrorError = null;
        current.defaultBranch = summary.defaultBranch;
        return { ...this._public(current), repository: summary };
      }, { actor, action: 'mirror.sync', target: id });
    } catch (error) {
      this.store.update(state => {
        const current = state.projects.find(item => item.id === id);
        current.mirrorError = String(error.message).slice(0, 2000);
        return current;
      }, { actor, action: 'mirror.failed', target: id });
      throw error;
    }
  }

  async detail(id) {
    const project = this.get(id);
    return { ...project, repository: await this.repositories.summary(project) };
  }

  protectedBranches(id) {
    return this.get(id).protectedBranches || [];
  }

  protectBranch(id, input, actor = 'api') {
    const branch = text(input.branch, 'Branch', { max: 1024, required: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//')) throw new Error('Branch is invalid');
    const rule = { branch, requiredApprovals: Math.max(0, Math.min(20, Number(input.requiredApprovals) || 0)), pushRole: ['developer', 'maintainer', 'owner'].includes(input.pushRole) ? input.pushRole : 'maintainer' };
    return this.store.update(state => {
      const project = state.projects.find(item => item.id === id);
      if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
      project.protectedBranches ||= [];
      const index = project.protectedBranches.findIndex(item => item.branch === branch);
      if (index >= 0) project.protectedBranches[index] = rule; else project.protectedBranches.push(rule);
      return rule;
    }, { actor, action: 'branch.protect', target: `${id}:${branch}` });
  }

  setStorageLimit(id, input, actor = 'api') {
    const value = Number(input.storageLimitBytes);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Storage limit must be a non-negative integer');
    return this.store.update(state => { const project = state.projects.find(item => item.id === id); if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 }); project.storageLimitBytes = value; project.updatedAt = new Date().toISOString(); return this._public(project); }, { actor, action: 'project.storage-limit', target: id });
  }
}

module.exports = { ProjectService };
