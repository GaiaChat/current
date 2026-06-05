#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import {
  chmod,
  chown,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)));
const installRoot = process.env.CURRENT_SERVER_INSTALL_ROOT || '/opt/current';
const stateDir = process.env.CURRENT_SERVER_STATE_DIR || '/var/lib/current';
const configDir = '/etc/current';
const configPath = join(configDir, 'current.config.json');
const serviceTemplate = join(sourceDir, 'deploy', 'current.service');
const serviceTarget = '/etc/systemd/system/current.service';
const pnpmVersion = process.env.CURRENT_PNPM_VERSION || '11.3.0';
const minimumNodeVersion = '24.0.0';
const symlinkSafePnpmArgs = [
  '--config.node-linker=hoisted',
  '--config.package-import-method=copy',
  '--config.prefer-symlinked-executables=false',
];

function parseArgs() {
  const options = {
    reinstall: process.argv.includes('--reinstall'),
    yes: process.argv.includes('--yes') || process.argv.includes('-y'),
    publicUrl: process.env.CURRENT_PUBLIC_URL
      ? normalizePublicUrl(process.env.CURRENT_PUBLIC_URL)
      : '',
    host: process.env.CURRENT_HOST?.trim() || process.env.CURRENT_SERVER_HOST?.trim() || '',
    port:
      process.env.CURRENT_PORT || process.env.CURRENT_SERVER_PORT || process.env.PORT
        ? normalizePort(
            process.env.CURRENT_PORT || process.env.CURRENT_SERVER_PORT || process.env.PORT,
          )
        : null,
    serverName: '',
    registrationMode: '',
    rtcAnnouncedIp: process.env.CURRENT_RTC_ANNOUNCED_IP?.trim() || '',
  };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--reinstall' || arg === '--yes' || arg === '-y') {
      continue;
    }
    if (
      arg === '--public-url' ||
      arg === '--host' ||
      arg === '--port' ||
      arg === '--server-name' ||
      arg === '--registration-mode' ||
      arg === '--rtc-announced-ip'
    ) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      if (arg === '--public-url') {
        options.publicUrl = normalizePublicUrl(value);
      } else if (arg === '--host') {
        options.host = value.trim();
      } else if (arg === '--port') {
        options.port = normalizePort(value);
      } else if (arg === '--server-name') {
        options.serverName = value.trim();
      } else if (arg === '--registration-mode') {
        options.registrationMode = normalizeRegistrationMode(value);
      } else {
        options.rtcAnnouncedIp = value.trim();
      }
      continue;
    }
    if (arg.startsWith('--public-url=')) {
      options.publicUrl = normalizePublicUrl(arg.slice('--public-url='.length));
      continue;
    }
    if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length).trim();
      continue;
    }
    if (arg.startsWith('--port=')) {
      options.port = normalizePort(arg.slice('--port='.length));
      continue;
    }
    if (arg.startsWith('--server-name=')) {
      options.serverName = arg.slice('--server-name='.length).trim();
      continue;
    }
    if (arg.startsWith('--registration-mode=')) {
      options.registrationMode = normalizeRegistrationMode(
        arg.slice('--registration-mode='.length),
      );
      continue;
    }
    if (arg.startsWith('--rtc-announced-ip=')) {
      options.rtcAnnouncedIp = arg.slice('--rtc-announced-ip='.length).trim();
      continue;
    }
    throw new Error(`Unknown option ${arg}.\n\n${usage()}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: sudo node install-current.mjs [options]',
    '',
    'Options:',
    '  --reinstall                    Reinstall this version if Current is already installed.',
    '  --yes, -y                      Answer yes to reinstall prompts.',
    '  --public-url <url>             Public origin for cloud/reverse-proxy hosting.',
    '  --host <address>               Listen address. Default: 0.0.0.0.',
    '  --port <port>                  TCP listen port. Default: 6414.',
    '  --server-name <name>           Initial server display name.',
    '  --registration-mode <mode>     invite_only, open_signup, or manual_approval.',
    '  --rtc-announced-ip <address>   Public IP/DNS advertised for voice transports.',
  ].join('\n');
}

function requireRoot() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Please run install-current.mjs as root (sudo).');
  }
}

function parseVersionParts(version) {
  return version
    .split('.')
    .map((part) => Number(part))
    .map((part) => (Number.isInteger(part) && part >= 0 ? part : 0));
}

function compareVersions(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }
  return 0;
}

function ensureNodeVersion() {
  if (compareVersions(process.versions.node, minimumNodeVersion) < 0) {
    throw new Error(
      `Node.js ${minimumNodeVersion}+ is required. Current Node.js is ${process.versions.node}.`,
    );
  }
}

function normalizePort(value) {
  const port = Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}". Use a number from 1 to 65535.`);
  }
  return port;
}

function normalizePublicUrl(value) {
  const trimmed = String(value).trim();
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid public URL "${trimmed}". Use a full http:// or https:// URL.`);
  }
}

function normalizeRegistrationMode(value) {
  const mode = String(value).trim();
  if (!['invite_only', 'open_signup', 'manual_approval'].includes(mode)) {
    throw new Error(
      `Invalid registration mode "${value}". Use invite_only, open_signup, or manual_approval.`,
    );
  }
  return mode;
}

function run(command, args, label, cwd = sourceDir) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
      },
      stdio: 'inherit',
      shell: false,
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

function output(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: sourceDir,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout.trim();
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: sourceDir,
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

function commandStdout(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: sourceDir,
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function readCurrentVersion() {
  for (const file of ['release-info.json', 'package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(join(sourceDir, file), 'utf8'));
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Keep looking.
    }
  }
  return '0.3.1';
}

function resolveInstallUser() {
  const name = process.env.SUDO_USER || output('id', ['-un'], 'current user lookup');
  return {
    name,
    uid: Number(output('id', ['-u', name], 'install user uid lookup')),
    gid: Number(output('id', ['-g', name], 'install user gid lookup')),
  };
}

function defaultConfig() {
  return {
    version: 1,
    server: {
      name: 'Current Server',
      slug: 'current-server',
      host: '0.0.0.0',
      port: 6414,
      publicUrl: 'http://127.0.0.1:6414',
      registrationMode: 'invite_only',
      tls: {
        enabled: false,
        certPath: '',
        keyPath: '',
        acme: {
          mode: 'off',
          email: '',
          domain: '',
          directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory',
          certDir: '',
          renewBeforeDays: 30,
        },
      },
    },
    auth: {
      mode: 'atproto',
      atprotoClientId: '',
      redirectUri: 'http://127.0.0.1:6414/api/v1/auth/oauth/callback',
      lanRedirectBaseUrl: '',
      authorizationEndpoint: 'https://bsky.social/oauth/authorize',
      tokenEndpoint: 'https://bsky.social/oauth/token',
      profileEndpoint: 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile',
      scope:
        'atproto transition:generic identity:handle rpc?aud=*&lxm=com.atproto.server.getSession',
      cookieSecret: 'change-me-super-secret-cookie-key-please',
      allowDevLogin: true,
    },
    storage: {
      sqlitePath: '/var/lib/current/current.sqlite',
      uploadDir: '/var/lib/current/uploads',
      mediaBackend: 'local',
    },
    media: {
      maxAttachmentBytes: 10485760,
      allowedMimePrefixes: ['image/', 'video/', 'audio/', 'application/pdf'],
      gifProvider: 'klipy',
      gifFallbackProvider: 'none',
      klipyApiKey: '',
      giphyApiKey: '',
    },
    appearance: {
      backgroundAttachmentId: '',
      panelColor: '',
      ownMessageColor: '',
      otherMessageColor: '',
    },
    moderation: {
      defaultSlowmodeSeconds: 0,
      maxMentionsPerMessage: 8,
      linkPolicy: 'members_only',
    },
    rtc: {
      listenIp: '0.0.0.0',
      announcedIp: '127.0.0.1',
      udpMinPort: 40000,
      udpMaxPort: 40100,
      workerCount: 0,
      sessionTimeoutMs: 45000,
      turnUrls: [],
    },
    observability: {
      metricsEnabled: true,
      logLevel: 'info',
    },
  };
}

function isLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname.startsWith('127.')
    );
  } catch {
    return false;
  }
}

function withPort(value, port) {
  const parsed = new URL(value);
  parsed.port = String(port);
  const next = parsed.toString();
  return parsed.pathname === '/' && !parsed.search && !parsed.hash ? next.replace(/\/$/, '') : next;
}

function withLoopbackPort(value, port) {
  return isLoopbackUrl(value) ? withPort(value, port) : value;
}

function buildDefaultOAuthRedirectUri(publicUrl) {
  const redirect = new URL(publicUrl);
  redirect.pathname = '/api/v1/auth/oauth/callback';
  redirect.search = '';
  redirect.hash = '';
  return redirect.toString();
}

function deriveDiscoverableClientIdFromPublicUrl(publicUrl) {
  try {
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)
    ) {
      return null;
    }
    if (!parsed.hostname.includes('.') || parsed.hostname.endsWith('.local')) {
      return null;
    }
    return new URL('/api/v1/auth/client-metadata.json', parsed).toString();
  } catch {
    return null;
  }
}

function applyInstallConfigOptions(config, options) {
  const next = structuredClone(config);
  if (options.serverName) {
    next.server.name = options.serverName;
  }
  if (options.host) {
    next.server.host = options.host;
  }
  if (options.port) {
    next.server.port = options.port;
    next.server.publicUrl = withLoopbackPort(next.server.publicUrl, options.port);
    next.auth.redirectUri = withLoopbackPort(next.auth.redirectUri, options.port);
  }
  if (options.publicUrl) {
    next.server.publicUrl = options.publicUrl;
    next.auth.redirectUri = buildDefaultOAuthRedirectUri(options.publicUrl);
    if (!next.auth.atprotoClientId) {
      next.auth.atprotoClientId = deriveDiscoverableClientIdFromPublicUrl(options.publicUrl) ?? '';
    }
  }
  if (options.registrationMode) {
    next.server.registrationMode = options.registrationMode;
  }
  if (options.rtcAnnouncedIp) {
    next.rtc.announcedIp = options.rtcAnnouncedIp;
  }
  return next;
}

async function maybeCreateConfig(options) {
  if (existsSync(configPath)) {
    const existing = JSON.parse(await readFile(configPath, 'utf8'));
    const next = applyInstallConfigOptions(existing, options);
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      console.log(`Updating cloud/server settings in ${configPath}`);
      await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
    }
    return;
  }
  console.log(`Creating default config at ${configPath}`);
  await writeFile(
    configPath,
    `${JSON.stringify(applyInstallConfigOptions(defaultConfig(), options), null, 2)}\n`,
  );
}

function relativePosix(path) {
  return relative(sourceDir, path).split(sep).join('/');
}

function shouldCopy(path) {
  const rel = relativePosix(path);
  if (!rel) {
    return true;
  }
  if (
    rel === '.git' ||
    rel === 'node_modules' ||
    rel === 'release-server' ||
    rel === 'apps/server/config' ||
    rel === 'apps/server/data' ||
    rel === 'apps/server/uploads' ||
    rel === 'apps/server/backups'
  ) {
    return false;
  }
  if (
    rel.startsWith('.git/') ||
    rel.startsWith('node_modules/') ||
    rel.startsWith('release-server/') ||
    rel.startsWith('apps/server/config/') ||
    rel.startsWith('apps/server/data/') ||
    rel.startsWith('apps/server/uploads/') ||
    rel.startsWith('apps/server/backups/')
  ) {
    return false;
  }
  return !/apps\/server\/.*\.sqlite(?:-shm|-wal)?$/.test(rel);
}

async function copySourceTree(targetDir) {
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: shouldCopy,
  });
}

async function switchCurrentSymlink(currentWorkdir, versionDir) {
  if (existsSync(currentWorkdir)) {
    const current = lstatSync(currentWorkdir);
    if (!current.isSymbolicLink()) {
      throw new Error(
        `${currentWorkdir} exists and is not a symlink. Move it aside before installing.`,
      );
    }
    await rm(currentWorkdir, { force: true });
  }
  await symlink(versionDir, currentWorkdir, 'dir');
}

async function writeServiceFile(currentUser, currentWorkdir) {
  const template = await readFile(serviceTemplate, 'utf8');
  await writeFile(
    serviceTarget,
    template
      .replaceAll('{{CURRENT_USER}}', currentUser.name)
      .replaceAll('{{CURRENT_WORKDIR}}', currentWorkdir),
  );
}

async function chownRecursive(path, uid, gid) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }

  await chown(path, uid, gid);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }

  for (const entry of await readdir(path)) {
    await chownRecursive(join(path, entry), uid, gid);
  }
}

function resolvePackageManager() {
  const installedPnpmVersion = commandStdout('pnpm');
  if (installedPnpmVersion === pnpmVersion) {
    return ['pnpm', []];
  }
  if (commandWorks('corepack', ['--version'])) {
    spawnSync('corepack', ['enable'], { cwd: sourceDir, stdio: 'ignore', shell: false });
    const prepare = spawnSync('corepack', ['prepare', `pnpm@${pnpmVersion}`, '--activate'], {
      cwd: sourceDir,
      stdio: 'ignore',
      shell: false,
    });
    if (prepare.status === 0) {
      return ['corepack', ['pnpm']];
    }
  }
  if (commandWorks('npx')) {
    return ['npx', ['--yes', `pnpm@${pnpmVersion}`]];
  }
  if (installedPnpmVersion) {
    throw new Error(
      `Found pnpm ${installedPnpmVersion}, but this project pins pnpm ${pnpmVersion}. Enable corepack or install the pinned pnpm version.`,
    );
  }
  throw new Error(
    `pnpm@${pnpmVersion} is required. Install Node.js ${minimumNodeVersion}+ with npm/npx, enable corepack, or install pnpm ${pnpmVersion}.`,
  );
}

async function installDependencies(currentWorkdir) {
  const [command, prefixArgs] = resolvePackageManager();
  if (existsSync(join(currentWorkdir, 'release-info.json'))) {
    try {
      await run(
        command,
        [...prefixArgs, 'install', '--prod', '--frozen-lockfile', ...symlinkSafePnpmArgs],
        'production dependency install',
        currentWorkdir,
      );
      return;
    } catch {
      await run(
        command,
        [...prefixArgs, 'install', '--prod', ...symlinkSafePnpmArgs],
        'production dependency install',
        currentWorkdir,
      );
      return;
    }
  }

  await run(command, [...prefixArgs, 'install'], 'dependency install', currentWorkdir);
  for (const target of [
    '@current/types',
    '@current/protocol',
    '@current/config',
    '@current/web',
    '@current/server',
  ]) {
    await run(
      command,
      [...prefixArgs, '--filter', target, 'build'],
      `${target} build`,
      currentWorkdir,
    );
  }
}

async function main() {
  const options = parseArgs();
  ensureNodeVersion();
  requireRoot();
  const currentUser = resolveInstallUser();
  const version = readCurrentVersion();
  const versionName = `current-server-v${version}`;
  const versionDir = join(installRoot, 'versions', versionName);
  const currentWorkdir = join(installRoot, 'current');

  if (!existsSync(serviceTemplate)) {
    throw new Error(`Missing service template: ${serviceTemplate}`);
  }

  if (
    !options.reinstall &&
    existsSync(currentWorkdir) &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !options.yes
  ) {
    console.log(`Current already appears to be installed at ${currentWorkdir}.`);
    const answer = await ask('Try reinstalling this update? [y/N] ');
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      console.log('Install cancelled. No changes made.');
      return;
    }
    console.log(`Reinstalling Current ${versionName}.`);
  } else if (options.reinstall) {
    console.log(`Reinstall requested. Reinstalling Current ${versionName}.`);
  }

  await mkdir(configDir, { recursive: true });
  await mkdir(join(installRoot, 'versions'), { recursive: true });
  await mkdir(join(stateDir, 'uploads'), { recursive: true });
  await mkdir(join(stateDir, 'backups'), { recursive: true });
  await maybeCreateConfig(options);

  const stageDir = join(installRoot, 'versions', `.stage-${versionName}-${process.pid}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  await copySourceTree(stageDir);

  await rm(versionDir, { recursive: true, force: true });
  await cp(stageDir, versionDir, { recursive: true, force: true, verbatimSymlinks: true });
  await rm(stageDir, { recursive: true, force: true });
  await switchCurrentSymlink(currentWorkdir, versionDir);
  await writeServiceFile(currentUser, currentWorkdir);

  await chownRecursive(installRoot, currentUser.uid, currentUser.gid);
  await chownRecursive(stateDir, currentUser.uid, currentUser.gid);
  await chown(configPath, 0, currentUser.gid).catch(() => undefined);
  await chmod(configPath, 0o640).catch(() => undefined);

  await installDependencies(currentWorkdir);

  await run('systemctl', ['daemon-reload'], 'systemd daemon reload');
  await run('systemctl', ['enable', 'current.service'], 'current.service enable');
  await run('systemctl', ['restart', 'current.service'], 'current.service restart');

  console.log('Current installed and started.');
  console.log('Service status: systemctl status current.service');
  console.log(`App symlink: ${currentWorkdir} -> ${versionDir}`);
  console.log(`Config file: ${configPath}`);
  console.log(`State dir: ${stateDir}`);
}

main().catch((error) => {
  console.error(`[Current install] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
