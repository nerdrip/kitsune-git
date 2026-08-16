const crypto = require('node:crypto');
const https = require('node:https');
const { text } = require('./validation');

const EVENTS = new Set(['project.created', 'mirror.synced', 'issue.created', 'issue.updated', 'merge_request.created', 'merge_request.approved', 'merge_request.merged', 'release.created']);

class WebhookService {
  constructor({ store, projects, secretVault }) { this.store = store; this.projects = projects; this.secretVault = secretVault; }

  list(projectId) {
    this.projects.get(projectId);
    const state = this.store.snapshot();
    return {
      webhooks: state.webhooks.filter(item => item.projectId === projectId).map(({ secret, ...item }) => ({ ...item, hasSecret: Boolean(secret) })),
      deliveries: state.webhookDeliveries.filter(item => item.projectId === projectId).slice(-100).reverse()
    };
  }

  create(projectId, input, actor) {
    this.projects.get(projectId);
    const parsed = new URL(String(input.url || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Webhook URL must use clean HTTPS');
    const events = Array.isArray(input.events) ? [...new Set(input.events.map(String))] : [];
    if (!events.length || events.some(event => !EVENTS.has(event))) throw new Error('Webhook events are invalid');
    const rawSecret = text(input.secret, 'Webhook secret', { max: 8192, required: true });
    if (!this.secretVault) throw new Error('KITSUNE_SECRET_KEY is required for webhooks');
    const hook = { id: crypto.randomUUID(), projectId, url: parsed.href, events, active: true, secret: this.secretVault.encrypt(rawSecret), createdAt: new Date().toISOString() };
    return this.store.update(state => { state.webhooks.push(hook); const { secret, ...safe } = hook; return { ...safe, hasSecret: true }; }, { actor, action: 'webhook.create', target: hook.id });
  }

  async emit(projectId, event, data) {
    if (!EVENTS.has(event) || !this.secretVault) return [];
    const hooks = this.store.snapshot().webhooks.filter(item => item.projectId === projectId && item.active && item.events.includes(event));
    return await Promise.allSettled(hooks.map(hook => this._deliver(hook, event, data)));
  }

  _deliver(hook, event, data) {
    const deliveryId = crypto.randomUUID();
    const payload = Buffer.from(JSON.stringify({ id: deliveryId, event, createdAt: new Date().toISOString(), data }), 'utf8');
    const signature = crypto.createHmac('sha256', this.secretVault.decrypt(hook.secret)).update(payload).digest('hex');
    return new Promise(resolve => {
      let settled = false;
      const request = https.request(hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'User-Agent': 'KitsuneGIT-Webhooks', 'X-Kitsune-Event': event, 'X-Kitsune-Delivery': deliveryId, 'X-Kitsune-Signature-256': `sha256=${signature}` } }, response => {
        response.resume(); response.once('end', () => finish(response.statusCode || 0, null));
      });
      const finish = (status, error) => {
        if (settled) return;
        settled = true;
        this.store.update(state => { state.webhookDeliveries.push({ id: deliveryId, projectId: hook.projectId, webhookId: hook.id, event, status, error: error ? String(error.message).slice(0, 1000) : null, createdAt: new Date().toISOString() }); state.webhookDeliveries = state.webhookDeliveries.slice(-10_000); return null; });
        resolve({ status, error: error?.message || null });
      };
      request.setTimeout(10_000, () => request.destroy(new Error('Webhook timed out')));
      request.once('error', error => finish(0, error)); request.end(payload);
    });
  }
}

module.exports = { WebhookService, EVENTS };
