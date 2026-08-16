const crypto = require('node:crypto');
const { text } = require('./validation');

class BoardService {
  constructor({ store, projects }) { this.store = store; this.projects = projects; }
  list(projectId) {
    this.projects.get(projectId);
    const state = this.store.snapshot();
    return state.boards.filter(item => item.projectId === projectId).map(board => ({
      ...board,
      lists: board.lists.map(list => ({
        ...list,
        issues: state.issues.filter(issue => issue.projectId === projectId && issue.state === 'open' && (
          list.label ? (issue.labels || []).includes(list.label) : !board.lists.some(candidate => candidate.label && (issue.labels || []).includes(candidate.label))
        ))
      }))
    }));
  }
  create(projectId, input, actor) {
    this.projects.get(projectId);
    const labels = Array.isArray(input.lists) ? input.lists.slice(0, 20) : [];
    const board = { id: crypto.randomUUID(), projectId, name: text(input.name, 'Board name', { max: 128, required: true }), lists: [{ id: crypto.randomUUID(), title: 'Open', label: null }, ...labels.map(value => { const label = text(value.label || value, 'Board label', { max: 64, required: true }); return { id: crypto.randomUUID(), title: text(value.title || label, 'Board list title', { max: 128, required: true }), label }; })], createdAt: new Date().toISOString() };
    return this.store.update(state => { state.boards.push(board); return board; }, { actor, action: 'board.create', target: board.id });
  }
  move(projectId, boardId, iid, listId, actor) {
    return this.store.update(state => {
      const board = state.boards.find(item => item.id === boardId && item.projectId === projectId);
      const issue = state.issues.find(item => item.projectId === projectId && item.iid === iid);
      const list = board?.lists.find(item => item.id === listId);
      if (!board || !issue || !list) throw Object.assign(new Error('Board, list, or issue not found'), { statusCode: 404 });
      const labels = new Set(issue.labels || []); for (const item of board.lists) if (item.label) labels.delete(item.label); if (list.label) labels.add(list.label);
      issue.labels = [...labels]; issue.updatedAt = new Date().toISOString(); return issue;
    }, { actor, action: 'board.move', target: `${projectId}#${iid}` });
  }
}

module.exports = { BoardService };
