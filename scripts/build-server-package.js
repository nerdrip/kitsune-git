#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rootLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const version = rootManifest.version;
const serverDependencies = ['@simplewebauthn/server', 'jose', 'ldapts', 'ssh2'];

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('Invalid server package version');
if (rootLock.version !== version || rootLock.packages?.['']?.version !== version) throw new Error('Root package lock version is out of sync');
for (const dependency of serverDependencies) {
  if (!rootManifest.dependencies?.[dependency]) throw new Error(`Missing server dependency in package.json: ${dependency}`);
}

function resolveDependencyKey(name, parentKey, packages) {
  let base = parentKey;
  while (true) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) break;
    const nestedIndex = base.lastIndexOf('/node_modules/');
    base = nestedIndex >= 0 ? base.slice(0, nestedIndex) : '';
  }
  return null;
}

function serverLock(manifest) {
  const sourcePackages = rootLock.packages || {};
  const selected = {};
  const visit = (name, parentKey = '') => {
    const key = resolveDependencyKey(name, parentKey, sourcePackages);
    if (!key) throw new Error(`Unable to resolve ${name} from ${parentKey || 'the server package root'}`);
    if (selected[key]) return;
    const entry = { ...sourcePackages[key] };
    delete entry.dev;
    delete entry.devOptional;
    selected[key] = entry;
    const childNames = new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
      ...Object.keys(entry.peerDependencies || {}).filter(peer => !entry.peerDependenciesMeta?.[peer]?.optional)
    ]);
    for (const child of childNames) visit(child, key);
  };
  for (const dependency of serverDependencies) visit(dependency);
  return {
    name: manifest.name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: manifest.name,
        version,
        license: manifest.license,
        dependencies: manifest.dependencies,
        engines: manifest.engines
      },
      ...selected
    }
  };
}

function copy(sourceRelativePath, destinationRoot, destinationRelativePath = sourceRelativePath) {
  const source = path.join(ROOT, sourceRelativePath);
  const destination = path.join(destinationRoot, destinationRelativePath);
  if (!fs.existsSync(source)) throw new Error(`Missing server package input: ${sourceRelativePath}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
}

const manifest = {
  name: 'kitsune-git-server',
  version,
  private: true,
  description: 'Self-hosted KitsuneGIT collaboration server',
  license: rootManifest.license,
  engines: { node: '>=22.13.0' },
  scripts: {
    start: 'node src/server/cli.js',
    backup: 'node src/server/backup-cli.js create',
    restore: 'node src/server/backup-cli.js restore',
    'migrate-sqlite': 'node src/server/metadata-cli.js migrate-to-sqlite'
  },
  dependencies: Object.fromEntries(serverDependencies.map(name => [name, rootManifest.dependencies[name]]))
};

const outputDirectory = path.join(ROOT, 'dist');
const archiveName = `KitsuneGIT-Server-${version}.tar.gz`;
const output = path.join(outputDirectory, archiveName);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-git-server-'));
const packageDirectoryName = `kitsune-git-server-${version}`;
const packageDirectory = path.join(temporaryRoot, packageDirectoryName);

try {
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(packageDirectory, 'package-lock.json'), `${JSON.stringify(serverLock(manifest), null, 2)}\n`, 'utf8');
  copy('src/server', packageDirectory);
  copy('deploy/server/README.md', packageDirectory, 'README.md');
  for (const file of ['Dockerfile.web', 'compose.web.yml', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/WEB.md']) copy(file, packageDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.rmSync(output, { force: true });
  run('tar', ['-czf', output, '-C', temporaryRoot, packageDirectoryName]);
  if (!fs.statSync(output).size) throw new Error('Server archive is empty');
  console.log(output);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
