#!/usr/bin/env node

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveNpmCli } = require('./npm-cli');

const ROOT_DIRECTORY = path.resolve(__dirname, '..');
const PROJECT_VERSION = require(path.join(ROOT_DIRECTORY, 'package.json')).version;
const HOST_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const TARGETS = {
  win: { installer: ['nsis'], portable: ['portable'] },
  mac: { installer: ['dmg'], portable: ['zip'] },
  linux: { installer: ['deb', 'rpm'], portable: ['AppImage', 'tar.gz'] }
};

function usage() {
  console.log(`Usage: node scripts/build-packages.js [options]

Options:
  --platform <native|win|mac|linux>  Target OS (default: native)
  --type <all|installer|portable>    Package kind (default: all)
  --arch <x64|arm64|all>            CPU architecture (default: x64)
  --publish <never|always>           electron-builder publish mode (default: never)
  --allow-cross                      Allow a non-native target where supported
  --skip-verify                      Skip checks and tests
  --checksums-only                   Refresh SHA256SUMS.txt for the current version
  --help                             Show this help

Portable formats: Windows portable EXE, macOS ZIP, Linux AppImage + tar.gz.
Installer formats: Windows NSIS, macOS DMG, Linux DEB + RPM.`);
}

function parseArguments(argv) {
  const options = {
    platform: 'native',
    type: 'all',
    arch: 'x64',
    publish: 'never',
    allowCross: false,
    skipVerify: false,
    checksumsOnly: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--allow-cross') {
      options.allowCross = true;
      continue;
    }
    if (argument === '--skip-verify') {
      options.skipVerify = true;
      continue;
    }
    if (argument === '--checksums-only') {
      options.checksumsOnly = true;
      continue;
    }
    const key = { '--platform': 'platform', '--type': 'type', '--arch': 'arch', '--publish': 'publish' }[argument];
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete option: ${argument}`);
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function runNpm(args) {
  const npmCli = resolveNpmCli();
  if (!npmCli) {
    throw new Error(`Unable to locate npm-cli.js for the active Node.js runtime (${process.execPath})`);
  }
  run(process.execPath, [npmCli, ...args]);
}

function writeChecksums() {
  const outputDirectory = path.join(ROOT_DIRECTORY, 'dist');
  if (!fs.existsSync(outputDirectory)) return;
  const packagePattern = /\.(?:exe|dmg|zip|AppImage|deb|rpm|tar\.gz)$/i;
  const lines = fs.readdirSync(outputDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.includes(`-${PROJECT_VERSION}-`) && packagePattern.test(entry.name))
    .map(entry => {
      const content = fs.readFileSync(path.join(outputDirectory, entry.name));
      return { name: entry.name, hash: crypto.createHash('sha256').update(content).digest('hex') };
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => `${entry.hash}  ${entry.name}`);
  if (lines.length) fs.writeFileSync(path.join(outputDirectory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.checksumsOnly) {
    writeChecksums();
    return;
  }
  if (!HOST_PLATFORM) throw new Error(`Unsupported build host: ${process.platform}`);
  if (options.platform === 'native') options.platform = HOST_PLATFORM;
  if (!TARGETS[options.platform]) throw new Error(`Unsupported platform: ${options.platform}`);
  if (!['all', 'installer', 'portable'].includes(options.type)) throw new Error(`Unsupported package type: ${options.type}`);
  if (!['x64', 'arm64', 'all'].includes(options.arch)) throw new Error(`Unsupported architecture: ${options.arch}`);
  if (!['never', 'always'].includes(options.publish)) throw new Error(`Unsupported publish mode: ${options.publish}`);
  if (options.platform !== HOST_PLATFORM && !options.allowCross) {
    throw new Error(
      `Reliable ${options.platform} packages require a native ${options.platform} host. `
      + 'Use the matching platform script or the GitHub Actions build matrix. '
      + 'Pass --allow-cross only when you have installed the required cross-build toolchain.'
    );
  }

  const [majorNodeVersion, minorNodeVersion] = process.versions.node.split('.').map(Number);
  if (majorNodeVersion < 22 || (majorNodeVersion === 22 && minorNodeVersion < 12)) {
    throw new Error('Node.js 22.12.0 or newer is required to build KitsuneGIT');
  }

  if (!options.skipVerify) runNpm(['run', 'verify']);
  runNpm(['run', 'generate-icons']);

  const targetGroup = TARGETS[options.platform];
  const targets = options.type === 'all'
    ? [...targetGroup.installer, ...targetGroup.portable]
    : targetGroup[options.type];
  const architectures = options.arch === 'all' ? ['x64', 'arm64'] : [options.arch];
  const builderCli = require.resolve('electron-builder/out/cli/cli.js');

  for (const architecture of architectures) {
    run(process.execPath, [path.join(ROOT_DIRECTORY, 'scripts', 'prepare-git-runtime.js'), '--platform', options.platform, '--arch', architecture]);
    const builderArgs = [
      builderCli,
      `--${options.platform}`,
      ...targets,
      `--${architecture}`,
      '--publish',
      options.publish
    ];
    console.log(`Building ${options.platform} ${options.type} packages for ${architecture}...`);
    run(process.execPath, builderArgs);
  }
  writeChecksums();
}

try {
  main();
} catch (error) {
  console.error(`[build] ${error.message}`);
  process.exit(1);
}
