#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractZip } = require('../src/main/safe-zip');
const manifest = require('../src/git/runtime-manifest.json');

const ROOT = path.resolve(__dirname, '..');
const PLATFORM_MAP = { win: 'win32', mac: 'darwin', linux: 'linux' };
const HOST_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];

function parseArguments(argv) {
  const result = { platform: HOST_PLATFORM, arch: process.arch, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--force') { result.force = true; continue; }
    if (argv[index] === '--platform' && argv[index + 1]) { result.platform = argv[++index]; continue; }
    if (argv[index] === '--arch' && argv[index + 1]) { result.arch = argv[++index]; continue; }
    throw new Error(`Unknown or incomplete option: ${argv[index]}`);
  }
  if (!PLATFORM_MAP[result.platform]) throw new Error(`Unsupported runtime platform: ${result.platform}`);
  if (!['x64', 'arm64'].includes(result.arch)) throw new Error(`Unsupported runtime architecture: ${result.arch}`);
  return result;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function download(url, destination, expectedHash, redirects = 0) {
  if (fs.existsSync(destination) && sha256(destination) === expectedHash) return Promise.resolve();
  if (redirects > 5) return Promise.reject(new Error(`Too many redirects for ${url}`));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.download`;
  fs.rmSync(temporary, { force: true });
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'KitsuneGIT-runtime-builder' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return download(new URL(response.headers.location, url).href, destination, expectedHash, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
      }
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      const output = fs.createWriteStream(temporary, { mode: 0o600 });
      response.on('data', chunk => {
        received += chunk.length;
        if (total && (received === total || received % (10 * 1024 * 1024) < chunk.length)) {
          process.stdout.write(`  ${path.basename(destination)} ${Math.round(received / total * 100)}%\n`);
        }
      });
      response.once('error', reject);
      output.once('error', reject);
      output.once('finish', () => {
        const actualHash = sha256(temporary);
        if (actualHash !== expectedHash) {
          fs.rmSync(temporary, { force: true });
          return reject(new Error(`SHA-256 mismatch for ${path.basename(destination)}: ${actualHash}`));
        }
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporary, destination);
        resolve();
      });
      response.pipe(output);
    });
    request.once('error', reject);
    request.setTimeout(120_000, () => request.destroy(new Error(`Download timed out: ${url}`)));
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result;
}

function findFile(directory, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const queue = [directory];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return target;
    }
  }
  return null;
}

async function extractArchive(archive, type, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (type === 'zip') return await extractZip(archive, { dir: destination });
  run('tar', ['-xf', archive, '-C', destination]);
}

function copyDirectoryContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true, force: true });
  }
}

async function installAddons(staging, platform, arch, cacheDirectory) {
  const key = `${PLATFORM_MAP[platform]}-${arch}`;
  const addons = manifest.addons[key];
  if (!addons) throw new Error(`Missing runtime add-ons for ${key}`);
  const temporary = fs.mkdtempSync(path.join(path.dirname(staging), '.addons-'));
  try {
    for (const [name, descriptor] of Object.entries(addons)) {
      if (name === 'gcm' && findFile(staging, platform === 'win' ? ['git-credential-manager.exe'] : ['git-credential-manager'])) {
        console.log(`Using GCM already supplied by the ${platform} Git distribution.`);
        continue;
      }
      const extension = descriptor.type === 'zip' ? 'zip' : 'tar.gz';
      const archive = path.join(cacheDirectory, `${key}-${name}-${descriptor.sha256.slice(0, 12)}.${extension}`);
      console.log(`Preparing ${name.toUpperCase()} ${key}...`);
      await download(descriptor.url, archive, descriptor.sha256);
      const extracted = path.join(temporary, name);
      await extractArchive(archive, descriptor.type, extracted);
      if (name === 'gcm') {
        const executable = findFile(extracted, platform === 'win' ? ['git-credential-manager.exe'] : ['git-credential-manager']);
        if (!executable) throw new Error(`GCM executable was not found in ${path.basename(archive)}`);
        copyDirectoryContents(path.dirname(executable), path.join(staging, 'gcm'));
        if (platform !== 'win') fs.chmodSync(path.join(staging, 'gcm', 'git-credential-manager'), 0o755);
      } else if (name === 'lfs') {
        const executable = findFile(extracted, platform === 'win' ? ['git-lfs.exe'] : ['git-lfs']);
        if (!executable) throw new Error(`Git LFS executable was not found in ${path.basename(archive)}`);
        const binaryDirectory = path.join(staging, platform === 'win' ? 'cmd' : 'bin');
        fs.mkdirSync(binaryDirectory, { recursive: true });
        const destination = path.join(binaryDirectory, platform === 'win' ? 'git-lfs.exe' : 'git-lfs');
        fs.copyFileSync(executable, destination);
        if (platform !== 'win') fs.chmodSync(destination, 0o755);
        const license = findFile(extracted, ['LICENSE.md', 'LICENSE']);
        if (license) {
          const licenseDirectory = path.join(staging, 'share', 'licenses', 'git-lfs');
          fs.mkdirSync(licenseDirectory, { recursive: true });
          fs.copyFileSync(license, path.join(licenseDirectory, path.basename(license)));
        }
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function prepareWindows(staging, arch, cacheDirectory) {
  const key = `win32-${arch}`;
  const descriptor = manifest.downloads[key];
  if (!descriptor) throw new Error(`Missing managed Git download for ${key}`);
  const archive = path.join(cacheDirectory, `${key}-git-${descriptor.sha256.slice(0, 12)}.zip`);
  console.log(`Preparing Git ${manifest.gitVersion} ${key}...`);
  await download(descriptor.url, archive, descriptor.sha256);
  await extractZip(archive, { dir: staging });
  if (!fs.existsSync(path.join(staging, 'cmd', 'git.exe'))) throw new Error('MinGit archive did not contain cmd/git.exe');
}

async function prepareUnix(staging, platform, arch, cacheDirectory) {
  if (platform !== HOST_PLATFORM || arch !== process.arch) {
    throw new Error(`Git source runtime must be built natively (${HOST_PLATFORM}-${process.arch}); requested ${platform}-${arch}`);
  }
  const descriptor = manifest.source;
  const archive = path.join(cacheDirectory, `git-${manifest.gitVersion}-${descriptor.sha256.slice(0, 12)}.tar.xz`);
  console.log(`Building Git ${manifest.gitVersion} for ${platform}-${arch}...`);
  await download(descriptor.url, archive, descriptor.sha256);
  const sourceRoot = fs.mkdtempSync(path.join(path.dirname(staging), '.git-source-'));
  try {
    run('tar', ['-xf', archive, '-C', sourceRoot]);
    const sourceDirectory = path.join(sourceRoot, `git-${manifest.gitVersion}`);
    if (!fs.existsSync(path.join(sourceDirectory, 'Makefile'))) throw new Error('Git source archive layout is unexpected');
    run('./configure', [`--prefix=${staging}`, '--without-tcltk'], { cwd: sourceDirectory });
    const makeOptions = [
      `-j${Math.max(1, Math.min(os.cpus().length, 8))}`,
      'NO_TCLTK=YesPlease',
      'NO_GETTEXT=YesPlease',
      'NO_PERL=YesPlease',
      'NO_PYTHON=YesPlease',
      // Git 2.55 still supports a C-only build. Keeping Rust optional makes
      // the bundled runtime reproducible on clean release hosts.
      'NO_RUST=YesPlease',
      'NO_INSTALL_HARDLINKS=YesPlease'
    ];
    run('make', [...makeOptions, 'all'], { cwd: sourceDirectory });
    run('make', [...makeOptions, 'install'], { cwd: sourceDirectory });
    const licenseDirectory = path.join(staging, 'share', 'licenses', 'git');
    fs.mkdirSync(licenseDirectory, { recursive: true });
    fs.copyFileSync(path.join(sourceDirectory, 'COPYING'), path.join(licenseDirectory, 'COPYING'));
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runtimeRoot = path.join(ROOT, 'build', 'runtime');
  const destination = path.join(runtimeRoot, `${options.platform}-${options.arch}`);
  const marker = path.join(destination, '.kitsune-runtime.json');
  if (!options.force && fs.existsSync(marker)) {
    try {
      const existing = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (existing.schemaVersion === 2 && existing.gitVersion === manifest.gitVersion && existing.gcmVersion === manifest.gcmVersion && existing.lfsVersion === manifest.lfsVersion) {
        console.log(`Runtime ${options.platform}-${options.arch} is already prepared.`);
        return;
      }
    } catch { /* rebuild invalid runtime */ }
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const cacheDirectory = path.join(runtimeRoot, 'cache');
  const staging = fs.mkdtempSync(path.join(runtimeRoot, `.prepare-${options.platform}-${options.arch}-`));
  try {
    if (options.platform === 'win') await prepareWindows(staging, options.arch, cacheDirectory);
    else await prepareUnix(staging, options.platform, options.arch, cacheDirectory);
    await installAddons(staging, options.platform, options.arch, cacheDirectory);
    fs.writeFileSync(path.join(staging, '.kitsune-runtime.json'), `${JSON.stringify({
      schemaVersion: 2,
      platform: options.platform,
      arch: options.arch,
      gitVersion: manifest.gitVersion,
      gcmVersion: manifest.gcmVersion,
      lfsVersion: manifest.lfsVersion
    }, null, 2)}\n`, 'utf8');
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    console.log(`Runtime ready: ${destination}`);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => {
  console.error(`[runtime] ${error.message}`);
  process.exit(1);
});
