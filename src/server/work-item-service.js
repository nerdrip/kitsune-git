const crypto = require('node:crypto');
const { text } = require('./validation');

class WorkItemService {
  constructor({ store, projects, policy = null, qualityGates = null }) {
    this.store = store;
    this.projects = projects;
    this.policy = policy;
    this.qualityGates = qualityGates;
  }

  listIssues(projectId) {
    this.projects.get(projectId);
    return this.store.snapshot().issues.filter(item => item.projectId === projectId);
  }

  createIssue(projectId, input, actor = 'api') {
    this.projects.get(projectId);
    const issues = this.listIssues(projectId);
    const now = new Date().toISOString();
    const issue = {
      id: crypto.randomUUID(), projectId, iid: Math.max(0, ...issues.map(item => item.iid)) + 1,
      title: text(input.title, 'Issue title', { max: 500, required: true }),
      description: text(input.description, 'Issue description', { max: 100_000 }),
      state: 'open', labels: Array.isArray(input.labels) ? input.labels.slice(0, 20).map(value => text(value, 'Label', { max: 64, required: true })) : [],
      author: actor, createdAt: now, updatedAt: now
    };
    return this.store.update(state => { state.issues.push(issue); return issue; }, { actor, action: 'issue.create', target: issue.id });
  }

  updateIssue(projectId, iid, input, actor = 'api') {
    this.projects.get(projectId);
    return this.store.update(state => {
      const issue = state.issues.find(item => item.projectId === projectId && item.iid === iid);
      if (!issue) throw Object.assign(new Error('Issue not found'), { statusCode: 404 });
      if (input.state !== undefined) {
        if (!['open', 'closed'].includes(input.state)) throw new Error('Issue state is invalid');
        issue.state = input.state;
      }
      if (input.title !== undefined) issue.title = text(input.title, 'Issue title', { max: 500, required: true });
      if (input.description !== undefined) issue.description = text(input.description, 'Issue description', { max: 100_000 });
      issue.updatedAt = new Date().toISOString();
      return issue;
    }, { actor, action: 'issue.update', target: `${projectId}#${iid}` });
  }

  listMergeRequests(projectId) {
    this.projects.get(projectId);
    return this.store.snapshot().mergeRequests.filter(item => item.projectId === projectId);
  }

  createMergeRequest(projectId, input, actor = 'api') {
    this.projects.get(projectId);
    const items = this.listMergeRequests(projectId);
    const sourceBranch = text(input.sourceBranch, 'Source branch', { max: 1024, required: true });
    const targetBranch = text(input.targetBranch, 'Target branch', { max: 1024, required: true });
    if (sourceBranch === targetBranch) throw new Error('Source and target branches must differ');
    const now = new Date().toISOString();
    const dependsOn = Array.isArray(input.dependsOn) ? [...new Set(input.dependsOn.slice(0, 20).map(Number))] : [];
    if (dependsOn.some(value => !Number.isSafeInteger(value) || !items.some(item => item.iid === value))) throw new Error('Merge request dependency is invalid');
    const item = {
      id: crypto.randomUUID(), projectId, iid: Math.max(0, ...items.map(value => value.iid)) + 1,
      title: text(input.title, 'Merge request title', { max: 500, required: true }),
      description: text(input.description, 'Merge request description', { max: 100_000 }),
      sourceBranch, targetBranch, dependsOn, state: 'open', draft: Boolean(input.draft), approvals: [], approvalCommits: {}, author: actor, createdAt: now, updatedAt: now
    };
    return this.store.update(state => { state.mergeRequests.push(item); return item; }, { actor, action: 'merge-request.create', target: item.id });
  }

  async approveMergeRequest(projectId, iid, actor) {
    const project = this.projects.get(projectId);
    const item = this.store.snapshot().mergeRequests.find(value => value.projectId === projectId && value.iid === iid);
    if (!item) throw Object.assign(new Error('Merge request not found'), { statusCode: 404 });
    const sourceHash = (await this.projects.repositories.run(['rev-parse', `refs/heads/${item.sourceBranch}`], { cwd: this.projects.repositories.pathFor(project) })).stdout.trim();
    return this.store.update(state => {
      const item = state.mergeRequests.find(value => value.projectId === projectId && value.iid === iid);
      if (!item) throw Object.assign(new Error('Merge request not found'), { statusCode: 404 });
      if (item.state !== 'open') throw new Error('Merge request is not open');
      item.approvals ||= [];
      item.approvalCommits ||= {};
      if (!item.approvals.includes(actor)) item.approvals.push(actor);
      item.approvalCommits[actor] = sourceHash;
      item.updatedAt = new Date().toISOString();
      return item;
    }, { actor, action: 'merge-request.approve', target: `${projectId}!${iid}` });
  }

  async mergeMergeRequest(projectId, iid, actor) {
    const state = this.store.snapshot();
    const item = state.mergeRequests.find(value => value.projectId === projectId && value.iid === iid);
    if (!item) throw Object.assign(new Error('Merge request not found'), { statusCode: 404 });
    if (item.state !== 'open' || item.draft) throw new Error('Merge request is not ready');
    const dependencies = state.mergeRequests.filter(value => value.projectId === projectId && (item.dependsOn || []).includes(value.iid));
    if (dependencies.some(value => value.state !== 'merged')) throw Object.assign(new Error('Dependent merge requests must be merged first'), { statusCode: 409 });
    const project = this.projects.get(projectId);
    const rule = (project.protectedBranches || []).find(value => value.branch === item.targetBranch);
    const requirements = this.policy ? await this.policy.mergeRequirements(projectId, item) : { requiredApprovals: 0, requiredReviewers: [], dismissStaleApprovals: false, requireMergeQueue: false, requiredQualityGates: [] };
    const sourceHash = (await this.projects.repositories.run(['rev-parse', `refs/heads/${item.sourceBranch}`], { cwd: this.projects.repositories.pathFor(project) })).stdout.trim();
    const validApprovals = (item.approvals || []).filter(username => !requirements.dismissStaleApprovals || item.approvalCommits?.[username] === sourceHash);
    if (validApprovals.length < Math.max(rule?.requiredApprovals || 0, requirements.requiredApprovals || 0)) throw Object.assign(new Error('Required approvals are missing or stale'), { statusCode: 409 });
    const missingReviewers = requirements.requiredReviewers.filter(username => !validApprovals.includes(username));
    if (missingReviewers.length) throw Object.assign(new Error(`Required reviewers are missing: ${missingReviewers.join(', ')}`), { statusCode: 409 });
    if (requirements.requireMergeQueue && !item.mergeQueueApproved) throw Object.assign(new Error('This branch requires the merge queue'), { statusCode: 409 });
    await this.qualityGates?.assert(projectId, item, requirements.requiredQualityGates);
    if (state.reviewThreads.some(thread => thread.projectId === projectId && thread.mergeRequestIid === iid && !thread.resolved)) throw Object.assign(new Error('Unresolved review threads must be resolved before merge'), { statusCode: 409 });
    const result = await this.projects.repositories.merge(project, { ...item, actor });
    return this.store.update(current => {
      const request = current.mergeRequests.find(value => value.id === item.id);
      request.state = 'merged'; request.mergeCommitSha = result.hash; request.mergedBy = actor; request.mergedAt = new Date().toISOString(); request.updatedAt = request.mergedAt;
      return request;
    }, { actor, action: 'merge-request.merge', target: `${projectId}!${iid}` });
  }

  reviewThreads(projectId, iid) {
    this.projects.get(projectId);
    if (!this.store.snapshot().mergeRequests.some(item => item.projectId === projectId && item.iid === iid)) throw Object.assign(new Error('Merge request not found'), { statusCode: 404 });
    return this.store.snapshot().reviewThreads.filter(item => item.projectId === projectId && item.mergeRequestIid === iid);
  }

  createReviewThread(projectId, iid, input, actor) {
    this.reviewThreads(projectId, iid);
    const filePath = text(input.filePath, 'Review file path', { max: 4096, required: true });
    if (filePath.startsWith('/') || filePath.includes('..') || filePath.includes('\\') || filePath.includes('\0')) throw new Error('Review file path is invalid');
    const line = Number(input.line);
    if (!Number.isSafeInteger(line) || line < 1 || line > 10_000_000) throw new Error('Review line is invalid');
    const now = new Date().toISOString();
    const thread = {
      id: crypto.randomUUID(), projectId, mergeRequestIid: iid,
      position: { filePath, line, side: input.side === 'old' ? 'old' : 'new', commitSha: input.commitSha ? text(input.commitSha, 'Commit SHA', { max: 64 }) : null },
      resolved: false, resolvedBy: null, resolvedAt: null,
      notes: [{ id: crypto.randomUUID(), body: text(input.body, 'Review comment', { max: 100_000, required: true }), author: actor, createdAt: now }],
      createdAt: now, updatedAt: now
    };
    return this.store.update(state => { state.reviewThreads.push(thread); return thread; }, { actor, action: 'review-thread.create', target: thread.id });
  }

  replyReviewThread(projectId, iid, threadId, input, actor) {
    return this.store.update(state => {
      const thread = state.reviewThreads.find(item => item.id === threadId && item.projectId === projectId && item.mergeRequestIid === iid);
      if (!thread) throw Object.assign(new Error('Review thread not found'), { statusCode: 404 });
      thread.notes.push({ id: crypto.randomUUID(), body: text(input.body, 'Review comment', { max: 100_000, required: true }), author: actor, createdAt: new Date().toISOString() });
      thread.updatedAt = new Date().toISOString();
      return thread;
    }, { actor, action: 'review-thread.reply', target: threadId });
  }

  resolveReviewThread(projectId, iid, threadId, resolved, actor) {
    return this.store.update(state => {
      const thread = state.reviewThreads.find(item => item.id === threadId && item.projectId === projectId && item.mergeRequestIid === iid);
      if (!thread) throw Object.assign(new Error('Review thread not found'), { statusCode: 404 });
      thread.resolved = Boolean(resolved); thread.resolvedBy = thread.resolved ? actor : null; thread.resolvedAt = thread.resolved ? new Date().toISOString() : null; thread.updatedAt = new Date().toISOString();
      return thread;
    }, { actor, action: 'review-thread.resolve', target: threadId });
  }

  changeGraph(projectId) {
    const items = this.listMergeRequests(projectId); const byIid = new Map(items.map(item => [item.iid, item]));
    return { nodes: items.map(item => ({ iid: item.iid, title: item.title, state: item.state, sourceBranch: item.sourceBranch, targetBranch: item.targetBranch, ready: item.state === 'open' && !(item.dependsOn || []).some(iid => byIid.get(iid)?.state !== 'merged') })), edges: items.flatMap(item => (item.dependsOn || []).map(dependency => ({ from: dependency, to: item.iid }))) };
  }
}

module.exports = { WorkItemService };
