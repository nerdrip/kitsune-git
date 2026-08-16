const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'deploy', 'plesk');
const output = path.join(root, 'dist', 'KitsuneGIT-Plesk-1.3.0.zip');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.rmSync(output, { force: true });

let result;
if (process.platform === 'win32') {
  const command = `Compress-Archive -Path '${source.replaceAll("'", "''")}\\*' -DestinationPath '${output.replaceAll("'", "''")}' -CompressionLevel Optimal`;
  result = spawnSync('powershell', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
} else {
  result = spawnSync('zip', ['-qr', output, '.'], { cwd: source, stdio: 'inherit' });
}
if (result.status !== 0) process.exit(result.status || 1);
console.log(output);
