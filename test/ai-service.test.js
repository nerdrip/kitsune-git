const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AiService } = require('../src/server/ai-service');

test('AI summaries require explicit project scopes and expose the transmitted data manifest', async t => {
  let received;
  const server = http.createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); received = JSON.parse(Buffer.concat(chunks)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: { content: 'Human-readable review summary' } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const state = { aiPolicies: [], aiRuns: [], mergeRequests: [{ projectId: 'project-1', iid: 7, title: 'Change parser', description: 'Safer parsing', sourceBranch: 'feature', targetBranch: 'main' }], audit: [] };
  const store = { snapshot: () => structuredClone(state), update: (mutator, audit) => { const result = mutator(state); state.audit.push(audit); return structuredClone(result); } };
  const projects = { get: id => { assert.equal(id, 'project-1'); return { id }; } };
  const reviews = { semanticDiff: async () => ({ sourceCommit: 'abc123', files: [{ path: 'parser.js', additions: 2, deletions: 1 }] }) };
  const address = server.address();
  const ai = new AiService({ store, projects, reviews, provider: { type: 'ollama', baseUrl: `http://127.0.0.1:${address.port}/`, model: 'private-model' } });
  assert.equal(ai.capability('project-1').policy.enabled, false);
  await assert.rejects(ai.summarizeMergeRequest('project-1', 7, { scopes: ['metadata'] }, 'alice'), /disabled/);
  ai.setPolicy('project-1', { enabled: true, allowedScopes: ['metadata', 'diff'] }, 'owner');
  const result = await ai.summarizeMergeRequest('project-1', 7, { scopes: ['metadata', 'diff'] }, 'alice');
  assert.equal(result.advisoryOnly, true);
  assert.deepEqual(result.dataManifest.map(item => item.scope), ['metadata', 'diff']);
  assert.match(received.messages[1].content, /UNTRUSTED CODE DIFF/);
  assert.equal(ai.runs('project-1')[0].output, undefined);
  assert.equal(state.audit.at(-1).action, 'ai.summary.create');
});
