#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepository = 'GaiaChat/current';
const defaultManifestUrl = `https://github.com/${defaultRepository}/releases/latest/download/current-server-latest.json`;
const fallbackPnpmVersion = process.env.CURRENT_PNPM_VERSION || '11.3.0';
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return [
    'Usage: sudo node scripts/update-current-server.mjs [options]',
    '',
    'Options:',
    '  --check                     Only report whether an update is available.',
    '  --no-restart                Stage the update without restarting current.service.',
    '  --manifest-url <url>        Override the update manifest URL.',
    '  --install-root <path>       Default: /opt/current',
    '  --state-dir <path>          Default: /var/lib/current',
    '  --config <path>             Default: /etc/current/current.config.json',
  ].join('\n');
}

function parseArgs() {
  const options = {
    check: false,
    restart: true,
    manifestUrl: process.env.CURRENT_SERVER_UPDATE_MANIFEST_URL || defaultManifestUrl,
    installRoot: process.env.CURRENT_SERVER_INSTALL_ROOT || '/opt/current',
    stateDir: process.env.CURRENT_SERVER_STATE_DIR || '/var/lib/current',
    configPath: process.env.CURRENT_CONFIG_PATH || '/etc/current/current.config.json',
  };

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--no-restart') {
      options.restart = false;
      continue;
    }
    if (arg === '--manifest-url' || arg === '--install-root' || arg === '--state-dir' || arg === '--config') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      if (arg === '--manifest-url') {
        options.manifestUrl = value;
      } else if (arg === '--install-root') {
        options.installRoot = value;
      } else if (arg === '--state-dir') {
        options.stateDir = value;
      } else {
        options.configPath = value;
      }
      continue;
    }
    throw new Error(`Unknown option ${arg}.\n\n${usage()}`);
  }

  return {
    ...options,
    installRoot: resolve(options.installRoot),
    stateDir: resolve(options.stateDir),
    configPath: resolve(options.configPath),
  };
}

function run(command, args, label, cwd = scriptRoot) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
      },
      stdio: 'inherit',
    });

    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${label} failed with ${signal || `exit code ${code ?? 1}`}`));
    });
  });
}

function runOutput(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: scriptRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit code ${result.status ?? 1}`}`);
  }
  return result.stdout;
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: scriptRoot,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function commandStdout(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: scriptRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectHash);
    stream.on('end', resolveHash);
  });
  return hash.digest('hex');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'CurrentServerUpdater/1',
    },
  });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'CurrentServerUpdater/1',
    },
  });
  if (!response.ok) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

function resolveAssetUrl(manifestUrl, assetUrl) {
  return new URL(assetUrl, manifestUrl).toString();
}

async function installedVersion(installRoot) {
  const candidates = [
    join(installRoot, 'current', 'release-info.json'),
    join(scriptRoot, 'release-info.json'),
    join(scriptRoot, 'package.json'),
  ];

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Keep looking.
    }
  }

  return null;
}

function selectLinuxAsset(manifest) {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const asset = assets.find((candidate) => candidate?.platform === 'linux') ?? assets[0];
  if (!asset || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string') {
    throw new Error('The update manifest does not contain a usable Linux asset.');
  }
  return asset;
}

function validateArchivePaths(archivePath, expectedRoot) {
  const listing = runOutput('tar', ['-tzf', archivePath], 'archive path validation');
  const entries = listing.split('\n').filter(Boolean);
  if (entries.length === 0) {
    throw new Error('The update archive is empty.');
  }

  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\0')) {
      throw new Error(`Refusing unsafe archive entry: ${entry}`);
    }
    const normalized = entry.replaceAll('\\', '/');
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error(`Refusing path traversal archive entry: ${entry}`);
    }
    if (normalized !== `${expectedRoot}/` && !normalized.startsWith(`${expectedRoot}/`)) {
      throw new Error(`Archive entry is outside ${expectedRoot}: ${entry}`);
    }
  }
}

function resolveStatePath(path, currentAppDir) {
  return isAbsolute(path) ? path : resolve(currentAppDir, path);
}

async function backupFileIfPresent(sourcePath, backupDir, backupName, backups) {
  if (!(await pathExists(sourcePath))) {
    return;
  }
  const targetPath = join(backupDir, backupName);
  await copyFile(sourcePath, targetPath);
  backups.push(targetPath);
}

async function backupServerState(options) {
  const backupDir = join(options.stateDir, 'backups');
  await mkdir(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];
  await backupFileIfPresent(options.configPath, backupDir, `${stamp}-current.config.json`, backups);

  try {
    const config = JSON.parse(await readFile(options.configPath, 'utf8'));
    const currentAppDir = join(options.installRoot, 'current');
    const sqlitePath = typeof config.storage?.sqlitePath === 'string'
      ? resolveStatePath(config.storage.sqlitePath, currentAppDir)
      : null;
    if (sqlitePath) {
      const sqliteBase = basename(sqlitePath);
      await backupFileIfPresent(sqlitePath, backupDir, `${stamp}-${sqliteBase}`, backups);
      await backupFileIfPresent(`${sqlitePath}-wal`, backupDir, `${stamp}-${sqliteBase}-wal`, backups);
      await backupFileIfPresent(`${sqlitePath}-shm`, backupDir, `${stamp}-${sqliteBase}-shm`, backups);
    }
  } catch (error) {
    console.warn(`[Current update] Could not inspect config for SQLite backup: ${error.message}`);
  }

  if (backups.length > 0) {
    console.log(`[Current update] Backed up ${backups.length} file(s) to ${backupDir}.`);
  } else {
    console.log('[Current update] No existing config or SQLite files needed backup.');
  }
}

function packageManager() {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  if (commandWorks(npx)) {
    return [npx, ['--yes', `pnpm@${fallbackPnpmVersion}`]];
  }
  const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  if (commandWorks(corepack)) {
    spawnSync(corepack, ['prepare', `pnpm@${fallbackPnpmVersion}`, '--activate'], {
      cwd: scriptRoot,
      stdio: 'ignore',
    });
    return [corepack, ['pnpm']];
  }
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  if (commandStdout(pnpm) === fallbackPnpmVersion) {
    return [pnpm, []];
  }
  throw new Error(`Could not find pnpm, corepack, or npx. Install Node.js 20+ and enable corepack, or install pnpm ${fallbackPnpmVersion}.`);
}

async function installProductionDependencies(versionDir) {
  const [command, prefixArgs] = packageManager();
  const args = [...prefixArgs, 'install', '--prod', '--frozen-lockfile'];
  try {
    await run(command, args, 'production dependency install', versionDir);
  } catch {
    await run(command, [...prefixArgs, 'install', '--prod'], 'production dependency install', versionDir);
  }
}

async function extractVersion(archivePath, options, expectedRoot) {
  const versionsDir = join(options.installRoot, 'versions');
  await mkdir(versionsDir, { recursive: true });

  const stagingDir = await mkdtemp(join(versionsDir, '.stage-'));
  try {
    await run('tar', ['-xzf', archivePath, '-C', stagingDir], 'archive extraction');
    const extractedDir = join(stagingDir, expectedRoot);
    const targetDir = join(versionsDir, expectedRoot);
    if (!(await pathExists(extractedDir))) {
      throw new Error(`Archive did not contain ${expectedRoot}.`);
    }

    await rm(targetDir, { recursive: true, force: true });
    await rename(extractedDir, targetDir);
    return targetDir;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function switchCurrentSymlink(options, targetDir) {
  await mkdir(options.installRoot, { recursive: true });
  const currentPath = join(options.installRoot, 'current');
  const tempLink = join(options.installRoot, `.current-${process.pid}`);
  await rm(tempLink, { force: true });
  await symlink(targetDir, tempLink, 'dir');
  try {
    await rename(tempLink, currentPath);
  } catch (error) {
    await rm(tempLink, { force: true });
    throw new Error(`Could not switch ${currentPath}. If it is a real directory, move it aside first. ${error.message}`);
  }
  console.log(`[Current update] Active server now points to ${targetDir}.`);
}

async function restartService(shouldRestart) {
  if (!shouldRestart) {
    console.log('[Current update] Restart skipped. Restart current.service when ready.');
    return;
  }
  if (!commandWorks('systemctl', ['--version'])) {
    console.log('[Current update] systemctl was not found. Restart Current manually.');
    return;
  }
  await run('systemctl', ['restart', 'current.service'], 'current.service restart');
}

async function main() {
  const options = parseArgs();
  const manifest = await fetchJson(options.manifestUrl);
  const latestVersion = String(manifest.version || '').trim();
  if (!latestVersion) {
    throw new Error('The update manifest does not include a version.');
  }

  const currentVersion = await installedVersion(options.installRoot);
  if (currentVersion === latestVersion) {
    console.log(`[Current update] Current server is already on ${latestVersion}.`);
    return;
  }

  console.log(`[Current update] Installed: ${currentVersion || 'unknown'}`);
  console.log(`[Current update] Available: ${latestVersion}`);
  if (options.check) {
    return;
  }

  const asset = selectLinuxAsset(manifest);
  const assetUrl = resolveAssetUrl(options.manifestUrl, asset.url);
  const archiveRoot = basename(asset.name || assetUrl).replace(/\.tar\.gz$/, '');
  const cacheDir = join(options.stateDir, 'update-cache');
  await mkdir(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, asset.name || `${archiveRoot}.tar.gz`);

  console.log(`[Current update] Downloading ${assetUrl}`);
  await downloadFile(assetUrl, archivePath);

  const digest = await sha256(archivePath);
  if (digest !== asset.sha256) {
    throw new Error(`Update archive checksum mismatch. Expected ${asset.sha256}, got ${digest}.`);
  }
  validateArchivePaths(archivePath, archiveRoot);

  await backupServerState(options);
  const versionDir = await extractVersion(archivePath, options, archiveRoot);
  await installProductionDependencies(versionDir);
  await switchCurrentSymlink(options, versionDir);
  await restartService(options.restart);
  console.log(`[Current update] Updated Current server to ${latestVersion}.`);
}

main().catch((error) => {
  console.error(`[Current update] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
