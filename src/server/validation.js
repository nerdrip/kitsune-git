const path = require('node:path');

const SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function slug(value, label = 'Slug') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SLUG.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`${label} must contain 1-64 lowercase letters, digits, dots, dashes or underscores`);
  }
  return normalized;
}

function text(value, label, { max = 10_000, required = false } = {}) {
  const normalized = String(value ?? '').trim();
  if ((required && !normalized) || normalized.length > max || normalized.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function visibility(value) {
  const normalized = String(value || 'private');
  if (!['private', 'internal', 'public'].includes(normalized)) throw new Error('Visibility is invalid');
  return normalized;
}

function remoteUrl(value, { allowFile = false } = {}) {
  const raw = text(value, 'Repository URL', { max: 4096, required: true });
  if (/^[^@\s]+@[^:\s]+:[^\s]+$/.test(raw)) return raw;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Repository URL is invalid'); }
  const protocols = allowFile ? ['https:', 'ssh:', 'file:'] : ['https:', 'ssh:'];
  if (!protocols.includes(parsed.protocol) || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`Repository URL must use ${allowFile ? 'HTTPS, SSH or file' : 'HTTPS or SSH'} without embedded credentials`);
  }
  return parsed.href;
}

function repositoryPath(root, namespace, name) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, slug(namespace, 'Namespace'), `${slug(name, 'Project name')}.git`);
  if (path.dirname(path.dirname(target)) !== resolvedRoot) throw new Error('Repository path escaped storage root');
  return target;
}

module.exports = { slug, text, visibility, remoteUrl, repositoryPath };
