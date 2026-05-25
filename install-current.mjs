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
const symlinkSafePnpmArgs = [
  '--config.node-linker=hoisted',
  '--config.package-import-method=copy',
  '--config.prefer-symlinked-executables=false',
];

function parseArgs() {
  return {
    reinstall: process.argv.includes('--reinstall'),
    yes: process.argv.includes('--yes') || process.argv.includes('-y'),
  };
}

function requireRoot() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Please run install-current.mjs as root (sudo).');
  }
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

async function maybeCreateConfig() {
  if (existsSync(configPath)) {
    return;
  }
  console.log(`Creating default config at ${configPath}`);
  await writeFile(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
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
  if (commandWorks('npx')) {
    return ['npx', ['--yes', `pnpm@${pnpmVersion}`]];
  }
  if (commandWorks('corepack')) {
    spawnSync('corepack', ['enable'], { cwd: sourceDir, stdio: 'ignore', shell: false });
    spawnSync('corepack', ['prepare', `pnpm@${pnpmVersion}`, '--activate'], {
      cwd: sourceDir,
      stdio: 'ignore',
      shell: false,
    });
    return ['corepack', ['pnpm']];
  }
  if (commandStdout('pnpm') === pnpmVersion) {
    return ['pnpm', []];
  }
  throw new Error(
    `pnpm@${pnpmVersion} is required. Install npm/npx, enable corepack, or update pnpm.`,
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
  requireRoot();
  const options = parseArgs();
  const currentUser = resolveInstallUser();
  const version = readCurrentVersion();
  const versionName = `current-server-v${version}`;
  const versionDir = join(installRoot, 'versions', versionName);
  const currentWorkdir = join(installRoot, 'current');

  if (!existsSync(serviceTemplate)) {
    throw new Error(`Missing service template: ${serviceTemplate}`);
  }
  if (!commandWorks(process.execPath, ['--version'])) {
    throw new Error('Node.js 20+ is required.');
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
  await maybeCreateConfig();

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
