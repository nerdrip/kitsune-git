class SearchService {
  constructor({ store, projects, auth }) { this.store = store; this.projects = projects; this.auth = auth; }
  async search(query, actor, projectId = null) {
    const q = String(query || '').trim(); if (q.length < 2 || q.length > 200 || q.includes('\0')) throw new Error('Search query must contain 2–200 characters');
    const lower = q.toLowerCase(); const state = this.store.snapshot();
    const accessible = state.projects.filter(project => (!projectId || project.id === projectId) && this.auth.canProject(project, actor, 'guest'));
    const ids = new Set(accessible.map(item => item.id));
    const result = {
      projects: accessible.filter(item => `${item.namespace}/${item.name} ${item.description || ''}`.toLowerCase().includes(lower)).slice(0, 50),
      issues: state.issues.filter(item => ids.has(item.projectId) && `${item.title} ${item.description || ''} ${(item.labels || []).join(' ')}`.toLowerCase().includes(lower)).slice(0, 100),
      mergeRequests: state.mergeRequests.filter(item => ids.has(item.projectId) && `${item.title} ${item.description || ''}`.toLowerCase().includes(lower)).slice(0, 100),
      code: []
    };
    for (const project of accessible.slice(0, 20)) {
      try {
        const output = await this.projects.repositories.run(['grep', '--line-number', '--no-color', '--fixed-strings', '-I', '-e', q, project.defaultBranch || 'main', '--'], { cwd: this.projects.repositories.pathFor(project) });
        for (const line of output.stdout.split('\n').filter(Boolean).slice(0, 50)) { const match = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(line); if (match) result.code.push({ projectId: project.id, path: match[1], line: Number(match[2]), preview: match[3].slice(0, 500) }); }
      } catch {}
      if (result.code.length >= 200) break;
    }
    return result;
  }
}

module.exports = { SearchService };
