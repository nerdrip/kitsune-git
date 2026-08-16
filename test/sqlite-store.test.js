const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { SqliteStore } = require('../src/server/sqlite-store');
const { JsonStore } = require('../src/server/json-store');

test('SQLite metadata backend coordinates transactions and scheduler leases across instances', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-sqlite-'));
  const file = path.join(root, 'database.sqlite');
  const first = new SqliteStore(file); const second = new SqliteStore(file);
  try {
    first.update(state => { state.issues.push({ id: 'one' }); return null; });
    second.update(state => { state.issues.push({ id: 'two' }); return null; });
    assert.deepEqual(first.snapshot().issues.map(item => item.id), ['one', 'two']);
    assert.equal(first.acquireLease('mirror', 'first', 1000, 100), true);
    assert.equal(second.acquireLease('mirror', 'second', 1000, 101), false);
    assert.equal(second.acquireLease('mirror', 'second', 1000, 1101), true);
  } finally { first.close(); second.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('metadata migration copies JSON state without overwriting a destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-migrate-'));
  try {
    const json = new JsonStore(path.join(root, 'database.json'));
    json.update(state => { state.issues.push({ id: 'preserved' }); return null; });
    const script = path.resolve(__dirname, '..', 'src', 'server', 'metadata-cli.js');
    const migrated = spawnSync(process.execPath, [script, 'migrate-to-sqlite'], { env: { ...process.env, KITSUNE_DATA_PATH: root }, encoding: 'utf8' });
    assert.equal(migrated.status, 0, migrated.stderr);
    const sqlite = new SqliteStore(path.join(root, 'database.sqlite'));
    assert.equal(sqlite.snapshot().issues[0].id, 'preserved'); sqlite.close();
    const repeated = spawnSync(process.execPath, [script, 'migrate-to-sqlite'], { env: { ...process.env, KITSUNE_DATA_PATH: root }, encoding: 'utf8' });
    assert.notEqual(repeated.status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
