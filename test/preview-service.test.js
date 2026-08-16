const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PreviewService, previewSignature } = require('../src/server/preview-service');

test('preview lifecycle uses fresh signed loopback provisioner requests', async t => {
  const secret = 'p'.repeat(48); const calls = [];
  const server = http.createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks).toString(); const timestamp = request.headers['x-kitsune-timestamp']; assert.equal(request.headers['x-kitsune-signature'], `sha256=${previewSignature(secret, timestamp, body)}`); calls.push(JSON.parse(body)); response.writeHead(calls.at(-1).action === 'create' ? 201 : 200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(calls.at(-1).action === 'create' ? { url: 'https://project-1-abc.previews.example.test' } : { deleted: true })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const project = { id: 'project-1', slug: 'sample' }; const state = { previewEnvironments: [], mergeRequests: [{ projectId: project.id, iid: 2, sourceBranch: 'feature' }], audit: [] };
  const store = { snapshot: () => structuredClone(state), update: (mutator, audit) => { const result = mutator(state); state.audit.push(audit); return structuredClone(result); } };
  const projects = { get: () => project, repositories: { pathFor: () => '/repo.git', run: async () => ({ stdout: 'abc123\n' }) } };
  const address = server.address(); const previews = new PreviewService({ store, projects, provisionerUrl: `http://127.0.0.1:${address.port}/`, provisionerSecret: secret });
  const created = await previews.create(project.id, 2, { targetUrl: 'https://app.example.test', expiresHours: 12 }, 'alice');
  assert.equal(created.state, 'active'); assert.equal(calls[0].commitSha, 'abc123');
  const removed = await previews.remove(project.id, created.id, 'alice'); assert.equal(removed.state, 'deleted'); assert.equal(calls[1].action, 'delete');
});
