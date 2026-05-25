#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = join(rootDir, 'apps', 'server');
const webDistDir = join(rootDir, 'apps', 'web', 'dist');
const isWindows = process.platform === 'win32';
const checkOnly = process.argv.includes('--check');
const validModes = new Set(['normal', 'dev']);
const validInstances = new Set(['standard', 'lan']);
const defaultStandardPort = 6414;
const defaultLanPort = 8081;
const standardConfigPath = join(serverRoot, 'config', 'current.config.json');
const lanConfigPath = join(serverRoot, 'config', 'current-lan.config.json');
const standardStorage = {
  sqlitePath: 'apps/server/data/current.sqlite',
  uploadDir: 'apps/server/uploads',
};
const lanStorage = {
  sqlitePath: 'apps/server/data/lan/current.sqlite',
  uploadDir: 'apps/server/uploads/lan',
};

function commandName(name) {
  return isWindows ? `${name}.cmd` : name;
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

function commandStdout(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
}

function readPnpmVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const packageManager = typeof packageJson.packageManager === 'string'
      ? packageJson.packageManager
      : '';
    const match = /^pnpm@(.+)$/.exec(packageManager);
    return match?.[1] ?? '11.3.0';
  } catch {
    return '11.3.0';
  }
}

function resolvePackageManager() {
  const pnpmVersion = readPnpmVersion();
  const npx = commandName('npx');
  if (commandWorks(npx)) {
    return {
      label: `pnpm ${pnpmVersion} via npx`,
      command: npx,
      prefixArgs: ['--yes', `pnpm@${pnpmVersion}`],
    };
  }

  const corepack = commandName('corepack');
  if (commandWorks(corepack, ['--version'])) {
    spawnSync(corepack, ['prepare', `pnpm@${pnpmVersion}`, '--activate'], {
      cwd: rootDir,
      stdio: 'ignore',
      shell: false,
    });
    return {
      label: `pnpm ${pnpmVersion} via corepack`,
      command: corepack,
      prefixArgs: ['pnpm'],
    };
  }

  const pnpm = commandName('pnpm');
  if (commandStdout(pnpm) === pnpmVersion) {
    return {
      label: `pnpm ${pnpmVersion}`,
      command: pnpm,
      prefixArgs: [],
    };
  }

  return null;
}

function displayPath(filePath) {
  const path = relative(rootDir, filePath);
  return path && !path.startsWith('..') ? path : filePath;
}

async function filesMatch(leftPath, rightPath) {
  try {
    const [left, right] = await Promise.all([
      readFile(leftPath),
      readFile(rightPath),
    ]);
    return left.equals(right);
  } catch {
    return false;
  }
}

async function dependencyInstallReason() {
  const requiredPaths = [
    join(rootDir, 'node_modules', '.pnpm'),
    join(rootDir, 'node_modules', '.bin', commandName('tsc')),
    join(rootDir, 'apps', 'server', 'node_modules'),
    join(rootDir, 'apps', 'web', 'node_modules'),
  ];
  const missingPath = requiredPaths.find((requiredPath) => !existsSync(requiredPath));
  if (missingPath) {
    return `missing ${displayPath(missingPath)}`;
  }

  const projectLockfile = join(rootDir, 'pnpm-lock.yaml');
  const installedLockfile = join(rootDir, 'node_modules', '.pnpm', 'lock.yaml');
  if (existsSync(projectLockfile)) {
    if (!existsSync(installedLockfile)) {
      return `missing ${displayPath(installedLockfile)}`;
    }
    if (!(await filesMatch(projectLockfile, installedLockfile))) {
      return 'pnpm-lock.yaml changed since the last dependency install';
    }
  }

  return null;
}

async function ensureDependencies(pm) {
  console.log('[Current] Checking first-time setup...');
  const reason = await dependencyInstallReason();
  if (!reason) {
    console.log('[Current] Dependencies are already installed and current.');
    return;
  }

  if (checkOnly) {
    throw new Error(`Dependencies need setup (${reason}). Run the launcher normally to install them.`);
  }

  console.log(`[Current] Dependencies need setup (${reason}).`);
  console.log('[Current] Installing dependencies before choosing a server mode...');
  await run(...pm(['install']), 'dependency install');
}

function resolveConfigPath(instance) {
  const configuredPath = process.env.CURRENT_CONFIG_PATH?.trim();
  if (!configuredPath) {
    return instance === 'lan' ? lanConfigPath : standardConfigPath;
  }
  return resolve(serverRoot, configuredPath);
}

function normalizeBrowserHost(host) {
  const trimmed = typeof host === 'string' ? host.trim() : '';
  if (!trimmed || trimmed === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (trimmed === '::' || trimmed === '[::]') {
    return '[::1]';
  }
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

function defaultLaunchConfig(instance) {
  const port = instance === 'lan' ? defaultLanPort : defaultStandardPort;
  return {
    host: '0.0.0.0',
    port,
    url: `http://127.0.0.1:${port}`,
  };
}

function normalizePort(value) {
  const port = Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}". Use a number from 1 to 65535.`);
  }
  return port;
}

function parsePortArg() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('Missing value for --port.');
      }
      return normalizePort(value);
    }
    if (arg.startsWith('--port=')) {
      return normalizePort(arg.slice('--port='.length));
    }
  }

  const envValue =
    process.env.CURRENT_PORT?.trim() ||
    process.env.CURRENT_SERVER_PORT?.trim() ||
    process.env.PORT?.trim();
  return envValue ? normalizePort(envValue) : null;
}

function withPort(url, port) {
  const parsed = new URL(url);
  parsed.port = String(port);
  return parsed.toString();
}

function applyLaunchPortOverride(config, portOverride) {
  if (!portOverride) {
    return config;
  }
  return {
    ...config,
    port: portOverride,
    url: withPort(config.url, portOverride),
  };
}

async function readServerLaunchConfig(instance, portOverride) {
  const fallback = defaultLaunchConfig(instance);
  const configPath = resolveConfigPath(instance);
  if (!existsSync(configPath)) {
    return applyLaunchPortOverride(fallback, portOverride);
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    const server = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.server : undefined;
    const host = typeof server?.host === 'string' ? server.host : fallback.host;
    const port = Number.isInteger(server?.port) && server.port > 0 ? server.port : fallback.port;
    const protocol = server?.tls?.enabled ? 'https' : 'http';
    const url = `${protocol}://${normalizeBrowserHost(host)}:${port}`;
    return applyLaunchPortOverride({
      host,
      port,
      url,
    }, portOverride);
  } catch {
    return applyLaunchPortOverride(fallback, portOverride);
  }
}

function buildLanDefaultConfig() {
  return {
    version: 1,
    server: {
      name: 'Current LAN Server',
      slug: 'current-lan-server',
      host: '0.0.0.0',
      port: defaultLanPort,
      publicUrl: `http://127.0.0.1:${defaultLanPort}`,
      registrationMode: 'open_signup',
      tls: {
        enabled: false,
        certPath: '',
        keyPath: '',
      },
    },
    auth: {
      mode: 'lan',
      atprotoClientId: '',
      redirectUri: `http://127.0.0.1:${defaultLanPort}/api/v1/auth/oauth/callback`,
      lanRedirectBaseUrl: '',
      authorizationEndpoint: 'https://bsky.social/oauth/authorize',
      tokenEndpoint: 'https://bsky.social/oauth/token',
      profileEndpoint: 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile',
      scope: 'atproto transition:generic',
      cookieSecret: 'change-me-super-secret-lan-cookie-key-please',
      allowDevLogin: true,
    },
    storage: {
      sqlitePath: lanStorage.sqlitePath,
      uploadDir: lanStorage.uploadDir,
      mediaBackend: 'local',
    },
    media: {
      maxAttachmentBytes: 10 * 1024 * 1024,
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
      udpMinPort: 40101,
      udpMaxPort: 40200,
      workerCount: 1,
      sessionTimeoutMs: 45_000,
      turnUrls: [],
    },
    observability: {
      metricsEnabled: true,
      logLevel: 'info',
    },
  };
}

function patchLanConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig
    : {};
  const server = config.server && typeof config.server === 'object' && !Array.isArray(config.server)
    ? config.server
    : {};
  const auth = config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)
    ? config.auth
    : {};
  const storage = config.storage && typeof config.storage === 'object' && !Array.isArray(config.storage)
    ? config.storage
    : {};
  const defaultConfig = buildLanDefaultConfig();

  return {
    ...defaultConfig,
    ...config,
    server: {
      ...defaultConfig.server,
      ...server,
      port:
        server.port === 8080 || server.port === defaultStandardPort || server.port === undefined
          ? defaultLanPort
          : server.port,
      publicUrl:
        typeof server.publicUrl === 'string' &&
        server.publicUrl.length > 0 &&
        !server.publicUrl.includes(':8080') &&
        !server.publicUrl.includes(`:${defaultStandardPort}`)
          ? server.publicUrl
          : `http://127.0.0.1:${defaultLanPort}`,
    },
    auth: {
      ...defaultConfig.auth,
      ...auth,
      mode: 'lan',
      redirectUri:
        typeof auth.redirectUri === 'string' &&
        auth.redirectUri.length > 0 &&
        !auth.redirectUri.includes(':8080') &&
        !auth.redirectUri.includes(`:${defaultStandardPort}`)
          ? auth.redirectUri
          : `http://127.0.0.1:${defaultLanPort}/api/v1/auth/oauth/callback`,
    },
    storage: {
      ...defaultConfig.storage,
      ...storage,
      sqlitePath:
        storage.sqlitePath === standardStorage.sqlitePath || storage.sqlitePath === undefined
          ? lanStorage.sqlitePath
          : storage.sqlitePath,
      uploadDir:
        storage.uploadDir === standardStorage.uploadDir || storage.uploadDir === undefined
          ? lanStorage.uploadDir
          : storage.uploadDir,
    },
  };
}

async function ensureInstanceConfig(instance) {
  const configPath = resolveConfigPath(instance);
  if (instance !== 'lan' || checkOnly) {
    return configPath;
  }

  let nextConfig = buildLanDefaultConfig();
  if (existsSync(configPath)) {
    try {
      nextConfig = patchLanConfig(JSON.parse(await readFile(configPath, 'utf8')));
    } catch {
      nextConfig = buildLanDefaultConfig();
    }
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return configPath;
}

function canListen(host, port) {
  return new Promise((resolveCanListen, rejectCanListen) => {
    const server = createServer();
    server.once('error', (error) => {
      resolveCanListen({
        available: false,
        code: error.code,
        message: error.message,
      });
    });
    server.once('listening', () => {
      server.close((error) => {
        if (error) {
          rejectCanListen(error);
          return;
        }
        resolveCanListen({ available: true });
      });
    });
    server.listen({
      host,
      port,
      exclusive: true,
    });
  });
}

function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function ask(question) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

function parseInstanceArg() {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--lan' || arg === 'lan') {
      return 'lan';
    }
    if (arg === '--standard' || arg === 'standard') {
      return 'standard';
    }
    if (arg.startsWith('--instance=')) {
      return arg.slice('--instance='.length).trim().toLowerCase();
    }
  }

  return process.env.CURRENT_SERVER_INSTANCE?.trim().toLowerCase();
}

async function chooseInstance() {
  const requestedInstance = parseInstanceArg();
  if (requestedInstance) {
    if (validInstances.has(requestedInstance)) {
      return requestedInstance;
    }
    throw new Error(`Unknown server instance "${requestedInstance}". Use standard or lan.`);
  }

  if (checkOnly) {
    return 'standard';
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'standard';
  }

  console.log('');
  console.log('Choose server instance:');
  console.log('  1) Standard - normal Current server using the standard config/data');
  console.log('  2) LAN      - separate LAN-only server using its own config/data on port 8081');

  const answer = (await ask('Server instance [1/standard, 2/lan] (default: standard): ')).trim().toLowerCase();
  if (!answer || answer === '1' || answer === 'standard' || answer === 's') {
    return 'standard';
  }
  if (answer === '2' || answer === 'lan' || answer === 'l') {
    return 'lan';
  }
  throw new Error(`Unknown server instance "${answer}". Use standard or lan.`);
}

function localLanUrls(port) {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) {
        continue;
      }
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function truncate(value, maxLength = 160) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function uniqueOwners(owners) {
  const byPid = new Map();
  for (const owner of owners) {
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const existing = byPid.get(pid) ?? {};
    byPid.set(pid, {
      ...existing,
      ...owner,
      pid,
      name: owner.name || existing.name || '',
      commandLine: owner.commandLine || existing.commandLine || '',
    });
  }
  return [...byPid.values()].filter((owner) => owner.pid !== process.pid);
}

function processInfo(pid, field) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function enrichPosixOwners(owners) {
  return uniqueOwners(owners).map((owner) => ({
    ...owner,
    name: owner.name || processInfo(owner.pid, 'comm'),
    commandLine: owner.commandLine || processInfo(owner.pid, 'command'),
  }));
}

function parseLsofOwners(output) {
  const owners = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const type = line[0];
    const value = line.slice(1);
    if (type === 'p') {
      if (current) {
        owners.push(current);
      }
      current = { pid: Number(value) };
    } else if (current && type === 'c') {
      current.name = value;
    }
  }
  if (current) {
    owners.push(current);
  }
  return owners;
}

function parsePidMatches(output) {
  const owners = [];
  const seen = new Set();
  const patterns = [/pid=(\d+)/g, /(?:^|\s)(\d+)\/[^\s,]+/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output))) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0 && !seen.has(pid)) {
        seen.add(pid);
        owners.push({ pid });
      }
    }
  }
  return owners;
}

function localAddressHasPort(address, port) {
  const normalized = String(address ?? '').replace(/^\[/, '').replace(/\]$/, '');
  return normalized.endsWith(`:${port}`) || normalized.endsWith(`.${port}`);
}

function parsePosixCommandOwners(output, port) {
  const owners = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const localAddress = columns[3] ?? '';
    if (!localAddressHasPort(localAddress, port)) {
      continue;
    }
    owners.push(...parsePidMatches(line));
  }
  return owners;
}

function findPosixPortOwners(port) {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
    encoding: 'utf8',
    shell: false,
  });
  if (lsof.status === 0 && lsof.stdout.trim()) {
    return enrichPosixOwners(parseLsofOwners(lsof.stdout));
  }

  const ss = spawnSync('ss', ['-ltnp'], {
    encoding: 'utf8',
    shell: false,
  });
  if (ss.status === 0) {
    const owners = parsePosixCommandOwners(ss.stdout, port);
    if (owners.length > 0) {
      return enrichPosixOwners(owners);
    }
  }

  const netstat = spawnSync('netstat', ['-ltnp'], {
    encoding: 'utf8',
    shell: false,
  });
  if (netstat.status === 0) {
    const owners = parsePosixCommandOwners(netstat.stdout, port);
    if (owners.length > 0) {
      return enrichPosixOwners(owners);
    }
  }

  return [];
}

function powershellCommand() {
  for (const command of ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell']) {
    if (commandWorks(command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])) {
      return command;
    }
  }
  return null;
}

function normalizeWindowsOwnerJson(raw) {
  if (!raw.trim()) {
    return [];
  }
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map((entry) => ({
    pid: Number(entry.pid ?? entry.ProcessId),
    name: String(entry.name ?? entry.Name ?? ''),
    commandLine: String(entry.commandLine ?? entry.CommandLine ?? ''),
  }));
}

function windowsProcessDetails(pid, shellCommand) {
  if (!shellCommand) {
    return { pid };
  }
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($process) {',
    '  [PSCustomObject]@{ pid = [int]$process.ProcessId; name = [string]$process.Name; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress',
    '}',
  ].join('; ');
  const result = spawnSync(shellCommand, ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return { pid };
  }
  try {
    return normalizeWindowsOwnerJson(result.stdout)[0] ?? { pid };
  } catch {
    return { pid };
  }
}

function parseWindowsNetstatOwners(output, port, shellCommand) {
  const owners = [];
  const portSuffix = `:${port}`;
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') {
      continue;
    }
    const localAddress = columns[1] ?? '';
    const state = columns[3] ?? '';
    const pid = Number(columns[4]);
    if (state.toUpperCase() === 'LISTENING' && localAddress.endsWith(portSuffix) && Number.isInteger(pid)) {
      owners.push(windowsProcessDetails(pid, shellCommand));
    }
  }
  return owners;
}

function findWindowsPortOwners(port) {
  const shellCommand = powershellCommand();
  if (shellCommand) {
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$processIds = @(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique)`,
      '$items = foreach ($ownerId in $processIds) {',
      '  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId"',
      '  if ($process) { [PSCustomObject]@{ pid = [int]$process.ProcessId; name = [string]$process.Name; commandLine = [string]$process.CommandLine } }',
      '}',
      '$items | ConvertTo-Json -Compress',
    ].join('; ');
    const result = spawnSync(shellCommand, ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      shell: false,
    });
    if (result.status === 0 && result.stdout.trim()) {
      try {
        return uniqueOwners(normalizeWindowsOwnerJson(result.stdout));
      } catch {
        // Fall back to netstat below.
      }
    }
  }

  const netstat = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    shell: false,
  });
  if (netstat.status !== 0) {
    return [];
  }
  return uniqueOwners(parseWindowsNetstatOwners(netstat.stdout, port, shellCommand));
}

function findPortOwners(port) {
  return isWindows ? findWindowsPortOwners(port) : findPosixPortOwners(port);
}

function isLikelyCurrentOwner(owner) {
  const text = `${owner.name ?? ''} ${owner.commandLine ?? ''}`.replaceAll('\\', '/').toLowerCase();
  return (
    text.includes('start-current-server.mjs') ||
    text.includes('@current/server') ||
    text.includes('apps/server/dist/index.js') ||
    text.includes('apps/server/src/dev-launcher.ts') ||
    text.includes('current-server-v') ||
    text.includes('/current-chat/')
  );
}

function describeOwner(owner) {
  const name = owner.name ? ` ${owner.name}` : '';
  const commandLine = owner.commandLine ? ` - ${truncate(owner.commandLine)}` : '';
  return `PID ${owner.pid}${name}${commandLine}`;
}

function stopOwner(owner, force = false) {
  if (isWindows) {
    const args = ['/PID', String(owner.pid), '/T'];
    if (force) {
      args.push('/F');
    }
    const result = spawnSync('taskkill.exe', args, {
      encoding: 'utf8',
      shell: false,
    });
    return result.status === 0;
  }

  try {
    process.kill(owner.pid, force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function waitForPortRelease(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await canListen(config.host, config.port);
    if (status.available) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function stopPortOwnersAndRetry(config, owners) {
  const stoppableOwners = uniqueOwners(owners);
  if (stoppableOwners.length === 0) {
    console.log('[Current] I could not identify a process to stop for this port.');
    return false;
  }

  for (const owner of stoppableOwners) {
    console.log(`[Current] Stopping ${describeOwner(owner)}...`);
    stopOwner(owner, false);
  }

  if (await waitForPortRelease(config, 5_000)) {
    console.log(`[Current] Port ${config.port} is free now.`);
    return true;
  }

  console.log(`[Current] Port ${config.port} is still busy after a graceful stop request.`);
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const answer = (await ask('Force stop the process tree using this port? [y/N]: ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      return false;
    }
  }

  for (const owner of stoppableOwners) {
    console.log(`[Current] Force stopping ${describeOwner(owner)}...`);
    stopOwner(owner, true);
  }

  if (await waitForPortRelease(config, 5_000)) {
    console.log(`[Current] Port ${config.port} is free now.`);
    return true;
  }

  console.log(`[Current] Port ${config.port} is still busy.`);
  return false;
}

async function ensurePortAvailable(config) {
  while (true) {
    const status = await canListen(config.host, config.port);
    if (status.available) {
      return true;
    }

    if (status.code !== 'EADDRINUSE') {
      throw new Error(`Could not check ${config.host}:${config.port}: ${status.message}`);
    }

    console.log('');
    console.log(`[Current] Port ${config.port} is already in use on ${config.host}.`);
    console.log(`[Current] Another Current server may already be running at ${config.url}.`);
    const portOwners = findPortOwners(config.port);
    const currentOwners = portOwners.filter(isLikelyCurrentOwner);
    const ownersToStop = currentOwners.length > 0 ? currentOwners : portOwners;
    const stopLabel = currentOwners.length > 0
      ? 'Stop the existing Current server and retry'
      : 'Stop the process using this port and retry';
    if (portOwners.length > 0) {
      console.log('[Current] Process using this port:');
      for (const owner of portOwners) {
        const marker = isLikelyCurrentOwner(owner) ? ' (Current)' : '';
        console.log(`  - ${describeOwner(owner)}${marker}`);
      }
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`Port ${config.port} is busy. Stop the process using it, then run the launcher again.`);
    }

    console.log('');
    console.log('What would you like to do?');
    console.log('  1) Open the existing server and exit');
    if (ownersToStop.length > 0) {
      console.log(`  2) ${stopLabel}`);
      console.log('  3) I stopped the other process, retry the port check');
      console.log('  4) Exit');
    } else {
      console.log('  2) I stopped the other process, retry the port check');
      console.log('  3) Exit');
    }
    const prompt = ownersToStop.length > 0
      ? 'Choose [1/open, 2/stop, 3/retry, 4/exit] (default: open): '
      : 'Choose [1/open, 2/retry, 3/exit] (default: open): ';
    const answer = (await ask(prompt)).trim().toLowerCase();

    if (!answer || answer === '1' || answer === 'open' || answer === 'o') {
      openUrl(config.url);
      console.log(`[Current] Opened ${config.url}.`);
      return false;
    }

    if (ownersToStop.length > 0 && (answer === '2' || answer === 'stop' || answer === 's')) {
      if (await stopPortOwnersAndRetry(config, ownersToStop)) {
        continue;
      }
      continue;
    }

    if (
      (ownersToStop.length > 0 && (answer === '3' || answer === 'retry' || answer === 'r')) ||
      (ownersToStop.length === 0 && (answer === '2' || answer === 'retry' || answer === 'r'))
    ) {
      continue;
    }

    if (
      (ownersToStop.length > 0 && (answer === '4' || answer === 'exit' || answer === 'e')) ||
      (ownersToStop.length === 0 && (answer === '3' || answer === 'exit' || answer === 'e'))
    ) {
      return false;
    }

    console.log(`[Current] Unknown choice "${answer}".`);
  }
}

function parseModeArg() {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dev' || arg === 'dev') {
      return 'dev';
    }
    if (arg === '--normal' || arg === 'normal') {
      return 'normal';
    }
    if (arg.startsWith('--mode=')) {
      return arg.slice('--mode='.length).trim().toLowerCase();
    }
  }

  return process.env.CURRENT_LAUNCH_MODE?.trim().toLowerCase();
}

async function chooseMode() {
  const requestedMode = parseModeArg();
  if (requestedMode) {
    if (validModes.has(requestedMode)) {
      return requestedMode;
    }
    throw new Error(`Unknown launch mode "${requestedMode}". Use normal or dev.`);
  }

  if (checkOnly) {
    return 'normal';
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'normal';
  }

  console.log('');
  console.log('Choose launch mode:');
  console.log('  1) Normal - builds once and runs the server without watchers');
  console.log('  2) Dev    - builds/watches the web GUI and restarts the server on source changes');

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await readline.question('Start mode [1/normal, 2/dev] (default: normal): ')).trim().toLowerCase();
    if (!answer || answer === '1' || answer === 'normal' || answer === 'n') {
      return 'normal';
    }
    if (answer === '2' || answer === 'dev' || answer === 'd') {
      return 'dev';
    }
    throw new Error(`Unknown launch mode "${answer}". Use normal or dev.`);
  } finally {
    readline.close();
  }
}

function run(command, args, label, extraEnv = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const env = {
      ...process.env,
      ...extraEnv,
    };
    if (env.NO_COLOR) {
      delete env.FORCE_COLOR;
    } else {
      env.FORCE_COLOR ??= '1';
    }
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (error) => {
      rejectRun(error);
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      const reason = signal ? signal : `exit code ${code ?? 1}`;
      rejectRun(new Error(`${label} stopped with ${reason}`));
    });
  });
}

async function buildForNormalMode(pm) {
  console.log('[Current] Building production server assets...');
  await run(...pm(['--filter', '@current/types', 'build']), 'types build');
  await run(...pm(['--filter', '@current/protocol', 'build']), 'protocol build');
  await run(...pm(['--filter', '@current/config', 'build']), 'config build');
  await run(...pm(['--filter', '@current/web', 'build']), 'web build');
  await run(...pm(['--filter', '@current/server', 'build']), 'server build');
}

async function main() {
  if (!existsSync(join(rootDir, 'package.json'))) {
    throw new Error(`Could not find Current repo root from ${rootDir}`);
  }

  const packageManager = resolvePackageManager();
  if (!packageManager) {
    throw new Error(
      [
        `Could not find pnpm@${readPnpmVersion()}.`,
        'Install Node.js 20+ from https://nodejs.org with npm/npx, run "corepack enable" once, or install the pinned pnpm version directly.',
      ].join(' '),
    );
  }

  const pm = (args) => [packageManager.command, [...packageManager.prefixArgs, ...args]];
  console.log(`[Current] Repo: ${rootDir}`);
  console.log(`[Current] Package manager: ${packageManager.label}`);
  await ensureDependencies(pm);

  const instance = await chooseInstance();
  const portOverride = parsePortArg();
  const configPath = await ensureInstanceConfig(instance);
  const mode = await chooseMode();
  const launchConfig = await readServerLaunchConfig(instance, portOverride);

  console.log(`[Current] Instance: ${instance}`);
  console.log(`[Current] Config: ${configPath}`);
  console.log(`[Current] Mode: ${mode}`);
  if (portOverride) {
    console.log(`[Current] Port override: ${portOverride}`);
  }
  console.log(`[Current] The server will be available at ${launchConfig.url} after startup.`);
  if (instance === 'lan') {
    const urls = localLanUrls(launchConfig.port);
    if (urls.length > 0) {
      console.log(`[Current] LAN clients can try: ${urls.join(', ')}`);
    }
  }

  if (checkOnly) {
    console.log('[Current] Launcher check passed.');
    return;
  }

  const shouldStart = await ensurePortAvailable(launchConfig);
  if (!shouldStart) {
    return;
  }

  if (mode === 'dev') {
    console.log('[Current] Starting dev server with source watchers. Press Ctrl+C in this terminal to stop it.');
    await run(...pm(['dev']), 'Current dev server', {
      CURRENT_CONFIG_PATH: configPath,
      CURRENT_SERVER_INSTANCE: instance,
      ...(portOverride ? { CURRENT_PORT: String(portOverride) } : {}),
    });
    return;
  }

  await buildForNormalMode(pm);
  console.log('[Current] Starting normal server. Press Ctrl+C in this terminal to stop it.');
  await run(
    ...pm(['--filter', '@current/server', 'start']),
    'Current normal server',
    {
      CURRENT_CONFIG_PATH: configPath,
      CURRENT_SERVER_INSTANCE: instance,
      ...(portOverride ? { CURRENT_PORT: String(portOverride) } : {}),
      CURRENT_WEB_DIST_DIR: webDistDir,
    },
  );
}

main().catch((error) => {
  console.error(`[Current] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
