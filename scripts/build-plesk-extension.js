const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'deploy', 'plesk');
const metadata = fs.readFileSync(path.join(source, 'meta.xml'), 'utf8');
const version = metadata.match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
const release = metadata.match(/<release>([^<]+)<\/release>/)?.[1]?.trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || '') || !/^\d+$/.test(release || '')) throw new Error('Invalid Plesk extension version metadata');
const output = path.join(root, 'dist', `KitsuneGIT-Plesk-${version}-r${release}.zip`);
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
