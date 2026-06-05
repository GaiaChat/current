#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

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

const rootDir = resolveCurrentRoot();
const minimumNodeVersion = '24.0.0';
const skipBuild = process.argv.includes('--skip-build');
const reinstallRequested = process.argv.includes('--reinstall');
const assumeYes = process.argv.includes('--yes') || process.argv.includes('-y');
const releaseInfoPath = join(rootDir, 'release-info.json');
const frozenLockfile = process.argv.includes('--frozen-lockfile') || process.env.CI === 'true';
const buildTargets = ['@current/types', '@current/protocol', '@current/config', '@current/ui'];
const symlinkSafePnpmArgs = [
  '--config.node-linker=hoisted',
  '--config.package-import-method=copy',
  '--config.prefer-symlinked-executables=false',
];

function commandName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(command, args, label) {
  return new Promise((resolveRun, rejectRun) => {
    console.log(`[Current install] ${label}...`);
    const env = { ...process.env };
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
  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const packageManager =
    typeof packageJson.packageManager === 'string' ? packageJson.packageManager : '';
  const match = /^pnpm@(.+)$/.exec(packageManager);
  return match?.[1] ?? '11.3.0';
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

function isReleaseBundle() {
  return existsSync(releaseInfoPath);
}

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function askYesNo(question, defaultValue = false) {
  if (assumeYes) {
    return true;
  }
  if (!isInteractive()) {
    return defaultValue;
  }

  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function filesMatch(leftPath, rightPath) {
  try {
    return readFileSync(leftPath).equals(readFileSync(rightPath));
  } catch {
    return false;
  }
}

function dependencySetupReason(releaseBundle) {
  if (!existsSync(join(rootDir, 'node_modules', '.pnpm'))) {
    return `missing ${join('node_modules', '.pnpm')}`;
  }
  if (releaseBundle) {
    if (!existsSync(join(rootDir, 'node_modules', 'fastify', 'package.json'))) {
      return `missing ${join('node_modules', 'fastify', 'package.json')}`;
    }
    if (!existsSync(join(rootDir, 'node_modules', 'acme-client', 'package.json'))) {
      return `missing ${join('node_modules', 'acme-client', 'package.json')}`;
    }
  } else {
    const missingBuildTarget = buildTargets.find((target) => {
      const packageDir = target.replace(/^@current\//, '');
      return !existsSync(join(rootDir, 'packages', packageDir, 'dist'));
    });
    if (missingBuildTarget) {
      return `missing build output for ${missingBuildTarget}`;
    }
  }

  const projectLockfile = join(rootDir, 'pnpm-lock.yaml');
  const installedLockfile = join(rootDir, 'node_modules', '.pnpm', 'lock.yaml');
  if (existsSync(projectLockfile)) {
    if (!existsSync(installedLockfile)) {
      return `missing ${join('node_modules', '.pnpm', 'lock.yaml')}`;
    }
    if (!filesMatch(projectLockfile, installedLockfile)) {
      return 'pnpm-lock.yaml changed since dependencies were installed';
    }
  }

  return null;
}

function setupLooksComplete(releaseBundle) {
  return dependencySetupReason(releaseBundle) === null;
}

function resolvePackageManager() {
  const pnpmVersion = readPnpmVersion();
  const pnpm = commandName('pnpm');
  const installedPnpmVersion = commandStdout(pnpm);
  if (installedPnpmVersion === pnpmVersion) {
    return {
      label: `pnpm ${pnpmVersion}`,
      command: pnpm,
      prefixArgs: [],
    };
  }

  const npx = commandName('npx');
  const corepack = commandName('corepack');
  if (commandWorks(corepack, ['--version'])) {
    spawnSync(corepack, ['enable'], {
      cwd: rootDir,
      stdio: 'ignore',
      shell: false,
    });
    const prepare = spawnSync(corepack, ['prepare', `pnpm@${pnpmVersion}`, '--activate'], {
      cwd: rootDir,
      stdio: 'ignore',
      shell: false,
    });
    if (prepare.status === 0) {
      return {
        label: `pnpm ${pnpmVersion} via corepack`,
        command: corepack,
        prefixArgs: ['pnpm'],
      };
    }
  }

  if (commandWorks(npx)) {
    return {
      label: `pnpm ${pnpmVersion} via npx`,
      command: npx,
      prefixArgs: ['--yes', `pnpm@${pnpmVersion}`],
    };
  }

  if (installedPnpmVersion) {
    throw new Error(
      `Found pnpm ${installedPnpmVersion}, but this project pins pnpm ${pnpmVersion}. Enable corepack or install the pinned pnpm version.`,
    );
  }

  throw new Error(
    `Could not run pnpm@${pnpmVersion}. Install Node.js ${minimumNodeVersion}+ with npm/npx, enable corepack, or install pnpm ${pnpmVersion}.`,
  );
}

async function main() {
  if (!existsSync(join(rootDir, 'package.json'))) {
    throw new Error(`Could not find Current repo root from ${rootDir}.`);
  }

  ensureNodeVersion();
  const packageManager = resolvePackageManager();
  const pm = (args) => [packageManager.command, [...packageManager.prefixArgs, ...args]];
  const releaseBundle = isReleaseBundle();
  console.log(`[Current install] Repo: ${rootDir}`);
  console.log(`[Current install] Package manager: ${packageManager.label}`);

  const setupReason = dependencySetupReason(releaseBundle);
  if (!reinstallRequested && setupReason === null) {
    const shouldReinstall = await askYesNo(
      '[Current install] Current setup already appears complete. Try reinstalling this update?',
      false,
    );
    if (!shouldReinstall) {
      console.log('[Current install] No changes made.');
      console.log('[Current install] Run Current with Run Current.mjs.');
      return;
    }
  } else if (reinstallRequested) {
    console.log('[Current install] Reinstall requested. Reinstalling this update.');
  } else {
    console.log(`[Current install] Setup needed: ${setupReason}.`);
  }

  const installArgs = releaseBundle ? ['install', '--prod', ...symlinkSafePnpmArgs] : ['install'];
  if (frozenLockfile && existsSync(join(rootDir, 'pnpm-lock.yaml'))) {
    installArgs.push('--frozen-lockfile');
  }
  await run(
    ...pm(installArgs),
    releaseBundle
      ? 'Installing runtime dependencies with a symlink-safe layout'
      : 'Installing dependencies',
  );

  if (releaseBundle) {
    console.log('[Current install] Release bundle setup complete.');
    console.log('[Current install] Run Current with Run Current.mjs.');
    return;
  }

  if (!skipBuild) {
    for (const target of buildTargets) {
      await run(...pm(['--filter', target, 'build']), `Building ${target}`);
    }
  }

  console.log('[Current install] Setup complete.');
  console.log('[Current install] Run Current with Run Current.mjs.');
}

main().catch((error) => {
  console.error(`[Current install] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
