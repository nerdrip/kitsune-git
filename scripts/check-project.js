#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function listJavaScriptFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listJavaScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) result.push(fullPath);
  }
  return result;
}

for (const directory of ['src', 'scripts', 'test']) {
  const fullDirectory = path.join(ROOT, directory);
  if (!fs.existsSync(fullDirectory)) continue;
  for (const file of listJavaScriptFiles(fullDirectory)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) fail(`Syntax error in ${path.relative(ROOT, file)}:\n${result.stderr.trim()}`);
  }
}

const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  fail('package.json and package-lock.json versions do not match');
}

try {
  const Ajv = require('ajv');
  const builderSchema = require('app-builder-lib/scheme.json');
  const validateBuilderConfig = new Ajv({ allErrors: true, strict: false }).compile(builderSchema);
  if (!validateBuilderConfig(packageJson.build)) {
    const details = validateBuilderConfig.errors
      .map(error => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    fail(`Invalid electron-builder configuration: ${details}`);
  }
} catch (error) {
  fail(`Unable to validate electron-builder configuration: ${error.message}`);
}

const requiredTargets = {
  win: ['nsis', 'portable'],
  mac: ['dmg', 'zip'],
  linux: ['AppImage', 'deb', 'rpm', 'tar.gz']
};
for (const [platform, targets] of Object.entries(requiredTargets)) {
  const configured = (packageJson.build?.[platform]?.target || []).map(target => (
    typeof target === 'string' ? target : target.target
  ));
  for (const target of targets) {
    if (!configured.includes(target)) fail(`Missing ${platform} package target: ${target}`);
  }
}
if (JSON.stringify(packageJson.build).includes('OWNER')) fail('Release configuration still contains an OWNER placeholder');
if (!fs.existsSync(path.join(ROOT, 'build', 'icon.png'))) fail('Missing build/icon.png');

const runtimeManifest = JSON.parse(read('src/git/runtime-manifest.json'));
const expectedRuntimeKeys = ['win32-x64', 'win32-arm64'];
const expectedAddonKeys = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
const validDownload = item => item && /^https:\/\//.test(item.url) && /^[0-9a-f]{64}$/.test(item.sha256);
if (!/^\d+\.\d+\.\d+$/.test(runtimeManifest.gitVersion || '') || !validDownload(runtimeManifest.source)) {
  fail('Git runtime manifest has an invalid version, source URL, or SHA-256');
}
for (const key of expectedRuntimeKeys) {
  if (!validDownload(runtimeManifest.downloads?.[key])) fail(`Missing or invalid managed Git archive: ${key}`);
}
for (const key of expectedAddonKeys) {
  for (const addon of ['gcm', 'lfs']) {
    if (!validDownload(runtimeManifest.addons?.[key]?.[addon])) fail(`Missing or invalid ${addon} runtime archive: ${key}`);
  }
}
const extraResources = JSON.stringify(packageJson.build?.extraResources || []);
if (!extraResources.includes('build/runtime/${os}-${arch}') || !extraResources.includes('git-runtime')) {
  fail('Packaged builds do not include the architecture-specific Git runtime');
}
if (!fs.existsSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'))) fail('Missing third-party runtime notices');

const workflowSource = read('.github/workflows/build-packages.yml');
for (const runner of ['windows-latest', 'windows-11-arm', 'macos-15-intel', 'macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm']) {
  if (!workflowSource.includes(`os: ${runner}`)) fail(`Native package workflow is missing runner: ${runner}`);
}

const mainSource = read('src/main/main.js');
const preloadSource = read('src/main/preload.js');
const rendererSource = read('src/renderer/app.js');
const htmlSource = read('src/renderer/index.html');

const registeredChannels = new Set([...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(match => match[1]));
const invokedChannels = new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]));
for (const channel of invokedChannels) {
  if (!registeredChannels.has(channel)) fail(`Preload invokes an unregistered IPC channel: ${channel}`);
}
for (const channel of registeredChannels) {
  if (!invokedChannels.has(channel)) fail(`Main registers an unused IPC channel: ${channel}`);
}

const exposedApis = new Set([...preloadSource.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map(match => match[1]));
const usedApis = new Set([...rendererSource.matchAll(/window\.api\.([A-Za-z_$][\w$]*)/g)].map(match => match[1]));
for (const api of usedApis) {
  if (!exposedApis.has(api)) fail(`Renderer uses an API missing from preload: ${api}`);
}
for (const api of exposedApis) {
  if (!usedApis.has(api)) fail(`Preload exposes an unused API: ${api}`);
}

if (!mainSource.includes('sandbox: true')) fail('Electron renderer sandbox is not enabled');
if (/\bexec(?:Sync)?\s*\(/.test(mainSource)) fail('Main process uses a shell-based exec call');
if (mainSource.includes('cd /d "${resolved}"')) fail('Terminal launch interpolates a repository path into cmd.exe syntax');
if (!htmlSource.includes("default-src 'none'")) fail('Renderer CSP is not deny-by-default');
const htmlIds = [...htmlSource.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const duplicateIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
if (duplicateIds.length) fail(`Renderer contains duplicate element ids: ${duplicateIds.join(', ')}`);

const diffCheck = spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8', shell: false });
if (diffCheck.status !== 0) fail(`git diff --check failed:\n${diffCheck.stdout}${diffCheck.stderr}`);

if (failures.length > 0) {
  console.error(`Project checks failed (${failures.length}):`);
  failures.forEach(message => console.error(`- ${message}`));
  process.exit(1);
}

console.log(`Project checks passed (${listJavaScriptFiles(path.join(ROOT, 'src')).length} source files checked).`);
