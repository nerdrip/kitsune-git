const fs = require('node:fs');
const path = require('node:path');

function npmCliCandidates(options = {}) {
  const execPath = options.execPath || process.execPath;
  const npmExecPath = options.npmExecPath === undefined ? process.env.npm_execpath : options.npmExecPath;
  const executableDirectory = path.dirname(execPath);
  return [
    npmExecPath,
    // Official Windows Node archives keep npm next to node.exe.
    path.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // setup-node Linux/macOS archives keep npm in ../lib/node_modules.
    path.resolve(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
}

function resolveNpmCli(options = {}) {
  return npmCliCandidates(options).find(candidate => fs.existsSync(candidate)) || null;
}

module.exports = { npmCliCandidates, resolveNpmCli };
