#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [action, archiveArgument] = process.argv.slice(2);
const dataPath = path.resolve(process.env.KITSUNE_DATA_PATH || path.join(process.cwd(), '.kitsune-web'));
if (!['create', 'restore'].includes(action) || !archiveArgument) {
  console.error('Usage: backup-cli.js {create|restore} <archive.tar.gz>');
  process.exit(2);
}
const archive = path.resolve(archiveArgument);
if (!archive.endsWith('.tar.gz') || archive === dataPath || archive.startsWith(`${dataPath}${path.sep}`)) throw new Error('Backup archive must be a .tar.gz file outside the data directory');

if (action === 'create') {
  if (!fs.statSync(dataPath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Data directory does not exist: ${dataPath}`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const temporary = `${archive}.${process.pid}.tmp`;
  const result = spawnSync('tar', ['-czf', temporary, '-C', dataPath, '.'], { stdio: 'inherit', shell: false });
  if (result.status !== 0) { fs.rmSync(temporary, { force: true }); process.exit(result.status || 1); }
  if (process.platform === 'win32') fs.rmSync(archive, { force: true });
  fs.renameSync(temporary, archive);
  console.log(archive);
} else {
  if (!fs.statSync(archive, { throwIfNoEntry: false })?.isFile()) throw new Error(`Backup archive does not exist: ${archive}`);
  const entries = fs.existsSync(dataPath) ? fs.readdirSync(dataPath) : [];
  if (entries.length) throw new Error('Restore target must be empty; stop the server and move the existing data directory first');
  fs.mkdirSync(dataPath, { recursive: true });
  const result = spawnSync('tar', ['-xzf', archive, '-C', dataPath, '--no-same-owner'], { stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status || 1);
  if (!['database.json', 'database.sqlite'].some(name => fs.statSync(path.join(dataPath, name), { throwIfNoEntry: false })?.isFile())) throw new Error('Restored archive does not contain a KitsuneGIT database');
  console.log(dataPath);
}
