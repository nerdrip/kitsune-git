const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveNpmCli } = require('../scripts/npm-cli');

function withFakeNodeLayout(layout, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-npm-cli-'));
  try {
    const executableDirectory = path.join(root, 'bin');
    const execPath = path.join(executableDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
    const cliPath = layout === 'adjacent'
      ? path.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '', 'utf8');
    callback({ execPath, cliPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('resolves npm from the Windows-style adjacent Node layout', () => {
  withFakeNodeLayout('adjacent', ({ execPath, cliPath }) => {
    assert.equal(resolveNpmCli({ execPath, npmExecPath: '' }), cliPath);
  });
});

test('resolves npm from the setup-node Linux/macOS layout', () => {
  withFakeNodeLayout('lib', ({ execPath, cliPath }) => {
    assert.equal(resolveNpmCli({ execPath, npmExecPath: '' }), cliPath);
  });
});
