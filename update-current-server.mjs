#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import {
  access,
  copyFile,
  cp,
  lstat,
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
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const defaultRepository = 'GaiaChat/current';
const defaultManifestUrl = `https://github.com/${defaultRepository}/releases/latest/download/current-server-latest.json`;
const fallbackPnpmVersion = process.env.CURRENT_PNPM_VERSION || '11.3.0';

function hasCurrentManifest(dir) {
  return existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'release-info.json'));
}

function resolveCurrentRoot() {
  const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)));
  for (const candidate of [process.cwd(), scriptDir, dirname(scriptDir)]) {
    const resolved = resolve(candidate);
    if (hasCurrentManifest(resolved)) {
      return resolved;
    }
  }
  return scriptDir;
}

const scriptRoot = resolveCurrentRoot();
const scriptRootRealPath = (() => {
  try {
    return realpathSync(scriptRoot);
  } catch {
    return scriptRoot;
  }
})();
const releaseBundleNamePattern = /^current-server-v\d+\.\d+\.\d+(?:[-+].+)?$/;
const nativeInstallRoot = '/opt/current';
const scriptRootHasReleaseInfo = existsSync(join(scriptRoot, 'release-info.json'));
const scriptRootIsNativeCurrent =
  scriptRoot === join(nativeInstallRoot, 'current') ||
  scriptRootRealPath.startsWith(join(nativeInstallRoot, 'versions') + '/');
const scriptRootLooksPortable =
  scriptRootHasReleaseInfo &&
  !scriptRootIsNativeCurrent &&
  (releaseBundleNamePattern.test(basename(scriptRoot)) ||
    releaseBundleNamePattern.test(basename(scriptRootRealPath)) ||
    basename(scriptRoot) === 'current');
const portableInstallRoot = (() => {
  if (!scriptRootLooksPortable) {
    return null;
  }
  if (basename(scriptRoot) === 'current') {
    return dirname(scriptRoot);
  }
  const parentDir = dirname(scriptRoot);
  return basename(parentDir) === 'versions' ? dirname(parentDir) : parentDir;
})();
const defaultInstallRoot =
  process.env.CURRENT_SERVER_INSTALL_ROOT || (portableInstallRoot ?? nativeInstallRoot);
const defaultStateDir =
  process.env.CURRENT_SERVER_STATE_DIR ||
  (scriptRootLooksPortable ? join(defaultInstallRoot, '.current-state') : '/var/lib/current');
const defaultConfigPath =
  process.env.CURRENT_CONFIG_PATH ||
  (scriptRootLooksPortable
    ? join(scriptRoot, 'apps', 'server', 'config', 'current.config.json')
    : '/etc/current/current.config.json');
const symlinkSafePnpmArgs = [
  '--config.node-linker=hoisted',
  '--config.package-import-method=copy',
  '--config.prefer-symlinked-executables=false',
];
const requiredReleaseFiles = [
  'package.json',
  'release-info.json',
  'Install Current.mjs',
  'Run Current.mjs',
  'Update Current.mjs',
  'update-current-server.mjs',
  'start-current-server.mjs',
  'install-local-current.mjs',
  'install-current.mjs',
  'current-script-wrapper.mjs',
  'apps/server/dist/index.js',
  'apps/web/dist/index.html',
];
const fallbackPortablePreservePaths = [
  'apps/server/config',
  'apps/server/data',
  'apps/server/uploads',
  'apps/server/backups',
];
const portableRefreshedScriptFiles = [
  'Install Current.mjs',
  'Run Current.mjs',
  'Update Current.mjs',
  'current-script-wrapper.mjs',
  'update-current-server.mjs',
  'start-current-server.mjs',
];

function usage() {
  return [
    'Usage: sudo node update-current-server.mjs [options]',
    '',
    'Options:',
    '  --check                     Only report whether an update is available.',
    '  --reinstall                 Reinstall the latest release even if it is already installed.',
    '  --yes                       Answer yes to interactive reinstall prompts.',
    '  --no-restart                Stage the update without restarting current.service.',
    '  --no-pause                  Do not wait for Enter/Return before exiting.',
    '  --manifest-url <url>        Override the update manifest URL.',
    `  --install-root <path>       Default: ${defaultInstallRoot}`,
    `  --state-dir <path>          Default: ${defaultStateDir}`,
    `  --config <path>             Default: ${defaultConfigPath}`,
  ].join('\n');
}

function parseArgs() {
  let installRootWasExplicit = Boolean(process.env.CURRENT_SERVER_INSTALL_ROOT);
  const options = {
    check: false,
    reinstall: false,
    yes: false,
    restart: true,
    noPause: false,
    manifestUrl: process.env.CURRENT_SERVER_UPDATE_MANIFEST_URL || defaultManifestUrl,
    installRoot: defaultInstallRoot,
    stateDir: defaultStateDir,
    configPath: defaultConfigPath,
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
    if (arg === '--reinstall') {
      options.reinstall = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg === '--no-restart') {
      options.restart = false;
      continue;
    }
    if (arg === '--no-pause') {
      options.noPause = true;
      continue;
    }
    if (
      arg === '--manifest-url' ||
      arg === '--install-root' ||
      arg === '--state-dir' ||
      arg === '--config'
    ) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      if (arg === '--manifest-url') {
        options.manifestUrl = value;
      } else if (arg === '--install-root') {
        options.installRoot = value;
        installRootWasExplicit = true;
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
    portableSourceDir: scriptRootLooksPortable && !installRootWasExplicit ? scriptRoot : null,
    portablePhysicalSourceDir:
      scriptRootLooksPortable && !installRootWasExplicit ? scriptRootRealPath : null,
  };
}

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function askYesNo(options, question, defaultValue = false) {
  if (options.yes) {
    return true;
  }
  if (!isInteractive()) {
    return defaultValue;
  }

  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  const prompt = `${question} ${suffix} `;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function waitForEnterToClose(options) {
  if (options.noPause || !isInteractive()) {
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('\nPress Enter/Return to close this window.');
  } finally {
    rl.close();
  }
}

function printCompletionSummary(input) {
  console.log('');
  console.log('[Current update] ==================================================');
  console.log(
    `[Current update] Update complete. Current server v${input.latestVersion} is installed.`,
  );
  if (input.reinstalled) {
    console.log('[Current update] Reinstalled the current release by request.');
  }
  console.log(`[Current update] Active app: ${input.versionDir}`);
  if (input.options.portableSourceDir) {
    console.log(
      `[Current update] Portable active path: ${join(input.options.installRoot, 'current')}`,
    );
  }
  console.log(`[Current update] Config: ${input.options.configPath}`);
  console.log(`[Current update] State: ${input.options.stateDir}`);
  if (input.restartResult === 'restarted') {
    console.log('[Current update] current.service was restarted.');
  } else if (input.restartResult === 'skipped') {
    console.log('[Current update] Restart was skipped. Restart current.service when ready.');
  } else {
    console.log('[Current update] Restart Current manually on this machine.');
  }
  console.log('[Current update] ==================================================');
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
    throw new Error(
      `${label} failed: ${result.stderr || result.stdout || `exit code ${result.status ?? 1}`}`,
    );
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

async function releaseVersionAt(rootDir) {
  for (const path of [join(rootDir, 'release-info.json'), join(rootDir, 'package.json')]) {
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

async function portableCurrentNeedsRepair(options, latestVersion) {
  if (!options.portableSourceDir) {
    return false;
  }

  const currentPath = join(options.installRoot, 'current');
  const currentVersion = await releaseVersionAt(currentPath);
  return currentVersion !== latestVersion;
}

async function repairPortableCurrentIfNeeded(options, latestVersion) {
  if (!(await portableCurrentNeedsRepair(options, latestVersion))) {
    return false;
  }

  if (options.check) {
    console.log(
      `[Current update] Portable active directory is not on ${latestVersion}; run without --check to repair ${join(options.installRoot, 'current')}.`,
    );
    return false;
  }

  const activeSourceDir = options.portablePhysicalSourceDir || options.portableSourceDir;
  await switchCurrentSymlink(options, activeSourceDir);
  await refreshPortableSourceScripts(options, activeSourceDir);
  return true;
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

function normalizePortablePreservePath(path) {
  if (typeof path !== 'string') {
    return null;
  }
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/g, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return parts.join('/');
}

function portablePreservePaths(manifest) {
  const manifestPaths = Array.isArray(manifest.install?.preserve) ? manifest.install.preserve : [];
  const relativeManifestPaths = manifestPaths.map(normalizePortablePreservePath).filter(Boolean);
  return relativeManifestPaths.length > 0 ? relativeManifestPaths : fallbackPortablePreservePaths;
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
    const sqlitePath =
      typeof config.storage?.sqlitePath === 'string'
        ? resolveStatePath(config.storage.sqlitePath, currentAppDir)
        : null;
    if (sqlitePath) {
      const sqliteBase = basename(sqlitePath);
      await backupFileIfPresent(sqlitePath, backupDir, `${stamp}-${sqliteBase}`, backups);
      await backupFileIfPresent(
        `${sqlitePath}-wal`,
        backupDir,
        `${stamp}-${sqliteBase}-wal`,
        backups,
      );
      await backupFileIfPresent(
        `${sqlitePath}-shm`,
        backupDir,
        `${stamp}-${sqliteBase}-shm`,
        backups,
      );
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
  throw new Error(
    `Could not find pnpm, corepack, or npx. Install Node.js 20+ and enable corepack, or install pnpm ${fallbackPnpmVersion}.`,
  );
}

async function installProductionDependencies(versionDir) {
  const [command, prefixArgs] = packageManager();
  const args = [...prefixArgs, 'install', '--prod', '--frozen-lockfile', ...symlinkSafePnpmArgs];
  try {
    await run(command, args, 'production dependency install', versionDir);
  } catch {
    await run(
      command,
      [...prefixArgs, 'install', '--prod', ...symlinkSafePnpmArgs],
      'production dependency install',
      versionDir,
    );
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

async function verifyStagedReleaseBundle(versionDir, expectedVersion) {
  const missingFiles = [];
  for (const relativePath of requiredReleaseFiles) {
    if (!(await pathExists(join(versionDir, relativePath)))) {
      missingFiles.push(relativePath);
    }
  }
  if (missingFiles.length > 0) {
    throw new Error(`Staged update is incomplete. Missing: ${missingFiles.join(', ')}`);
  }

  const releaseInfo = JSON.parse(await readFile(join(versionDir, 'release-info.json'), 'utf8'));
  const stagedVersion = String(releaseInfo.version || '').trim();
  if (stagedVersion !== expectedVersion) {
    throw new Error(
      `Staged update version mismatch. Expected ${expectedVersion}, got ${stagedVersion || 'unknown'}.`,
    );
  }

  console.log(
    '[Current update] Verified full release bundle, including root updater launchers and latest script files.',
  );
}

async function preservePortableServerState(options, versionDir, manifest) {
  if (!options.portableSourceDir) {
    return;
  }

  const copiedPaths = [];
  for (const relativePath of portablePreservePaths(manifest)) {
    const sourcePath = join(options.portableSourceDir, relativePath);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    const targetPath = join(versionDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    copiedPaths.push(relativePath);
  }

  if (copiedPaths.length > 0) {
    console.log(`[Current update] Preserved portable server state: ${copiedPaths.join(', ')}`);
  } else {
    console.log('[Current update] No portable server state was found to preserve.');
  }
}

async function refreshPortableSourceScripts(options, versionDir) {
  if (!options.portableSourceDir) {
    return;
  }

  const copiedFiles = [];
  const targetDirs = Array.from(
    new Set(
      [options.portableSourceDir, options.portablePhysicalSourceDir].filter(
        (path) => typeof path === 'string' && path.length > 0,
      ),
    ),
  );
  for (const relativePath of portableRefreshedScriptFiles) {
    const sourcePath = join(versionDir, relativePath);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    for (const targetDir of targetDirs) {
      const targetPath = join(targetDir, relativePath);
      if (resolve(sourcePath) === resolve(targetPath)) {
        continue;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
    copiedFiles.push(relativePath);
  }

  if (copiedFiles.length > 0) {
    console.log(
      `[Current update] Refreshed old portable launch scripts: ${copiedFiles.join(', ')}`,
    );
  }
}

function canFallBackToPortableDirectory(options, error) {
  return (
    options.portableSourceDir &&
    ['EPERM', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EISDIR', 'ENOTEMPTY'].includes(error?.code)
  );
}

async function switchCurrentDirectoryCopy(options, targetDir, cause) {
  const currentPath = join(options.installRoot, 'current');
  const tempDir = join(options.installRoot, `.current-${process.pid}`);
  const previousDir = join(
    options.installRoot,
    `previous-current-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );

  console.log(
    `[Current update] Portable drive cannot create symlinks (${cause.code || cause.message}).`,
  );
  console.log(`[Current update] Copying active server directory to ${currentPath} instead.`);

  await rm(tempDir, { recursive: true, force: true });
  await cp(targetDir, tempDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  try {
    await lstat(currentPath);
    await rename(currentPath, previousDir);
    console.log(`[Current update] Moved previous active server to ${previousDir}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      await rm(tempDir, { recursive: true, force: true });
      throw new Error(`Could not move existing ${currentPath}: ${error.message}`);
    }
  }

  await rename(tempDir, currentPath);
  console.log(`[Current update] Active server now lives at ${currentPath}.`);
  return 'directory';
}

async function switchCurrentSymlink(options, targetDir) {
  await mkdir(options.installRoot, { recursive: true });
  const currentPath = join(options.installRoot, 'current');
  const tempLink = join(options.installRoot, `.current-${process.pid}`);
  await rm(tempLink, { force: true });
  try {
    await symlink(targetDir, tempLink, 'dir');
  } catch (error) {
    await rm(tempLink, { recursive: true, force: true });
    if (canFallBackToPortableDirectory(options, error)) {
      return switchCurrentDirectoryCopy(options, targetDir, error);
    }
    throw error;
  }
  try {
    await rename(tempLink, currentPath);
  } catch (error) {
    await rm(tempLink, { recursive: true, force: true });
    if (canFallBackToPortableDirectory(options, error)) {
      return switchCurrentDirectoryCopy(options, targetDir, error);
    }
    throw new Error(
      `Could not switch ${currentPath}. If it is a real directory, move it aside first. ${error.message}`,
    );
  }
  console.log(`[Current update] Active server now points to ${targetDir}.`);
  return 'symlink';
}

async function restartService(shouldRestart) {
  if (!shouldRestart) {
    console.log('[Current update] Restart skipped. Restart current.service when ready.');
    return 'skipped';
  }
  if (!commandWorks('systemctl', ['--version'])) {
    console.log('[Current update] systemctl was not found. Restart Current manually.');
    return 'manual';
  }
  await run('systemctl', ['restart', 'current.service'], 'current.service restart');
  return 'restarted';
}

async function main(options) {
  const manifest = await fetchJson(options.manifestUrl);
  const latestVersion = String(manifest.version || '').trim();
  if (!latestVersion) {
    throw new Error('The update manifest does not include a version.');
  }

  const currentVersion = await installedVersion(options.installRoot);
  let reinstallingCurrentVersion = false;
  if (currentVersion === latestVersion && !options.reinstall) {
    console.log(`[Current update] Current server is already on ${latestVersion}.`);
    const repairedPortableCurrent = await repairPortableCurrentIfNeeded(options, latestVersion);
    if (repairedPortableCurrent) {
      console.log('[Current update] Portable active directory was repaired.');
    }
    if (options.check) {
      return;
    }
    const shouldReinstall = await askYesNo(
      options,
      `[Current update] Try reinstalling this update?`,
      false,
    );
    if (!shouldReinstall) {
      console.log('[Current update] No changes made.');
      return;
    }
    reinstallingCurrentVersion = true;
    console.log(`[Current update] Reinstalling Current server v${latestVersion}.`);
  }

  console.log(`[Current update] Installed: ${currentVersion || 'unknown'}`);
  console.log(`[Current update] Available: ${latestVersion}`);
  console.log(`[Current update] Install root: ${options.installRoot}`);
  if (options.portableSourceDir) {
    console.log(`[Current update] Portable source: ${options.portableSourceDir}`);
  }
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
  await verifyStagedReleaseBundle(versionDir, latestVersion);
  await preservePortableServerState(options, versionDir, manifest);
  await installProductionDependencies(versionDir);
  await switchCurrentSymlink(options, versionDir);
  await refreshPortableSourceScripts(options, versionDir);
  const restartResult = await restartService(options.restart);
  printCompletionSummary({
    latestVersion,
    versionDir,
    restartResult,
    reinstalled: options.reinstall || reinstallingCurrentVersion,
    options,
  });
}

let options;
let exitCode = 0;
try {
  options = parseArgs();
  await main(options);
} catch (error) {
  exitCode = 1;
  console.error(`[Current update] ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (options) {
    await waitForEnterToClose(options);
  }
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
