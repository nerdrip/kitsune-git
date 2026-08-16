const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');

describe('web backup and restore', () => {
  it('round-trips into a new empty data directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-backup-'));
    try {
      const source = path.join(root, 'source');
      const target = path.join(root, 'target');
      const archive = path.join(root, 'backup.tar.gz');
      fs.mkdirSync(path.join(source, 'repositories'), { recursive: true });
      fs.writeFileSync(path.join(source, 'database.json'), '{"version":1,"projects":[]}\n');
      fs.writeFileSync(path.join(source, 'repositories', 'marker'), 'repository');
      const script = path.resolve(__dirname, '../src/server/backup-cli.js');
      assert.equal(spawnSync(process.execPath, [script, 'create', archive], { env: { ...process.env, KITSUNE_DATA_PATH: source } }).status, 0);
      assert.equal(spawnSync(process.execPath, [script, 'restore', archive], { env: { ...process.env, KITSUNE_DATA_PATH: target } }).status, 0);
      assert.equal(fs.readFileSync(path.join(target, 'repositories', 'marker'), 'utf8'), 'repository');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
