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
const minimumNodeMajor = 20;
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

function ensureNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < minimumNodeMajor) {
    throw new Error(
      `Node.js ${minimumNodeMajor}+ is required. Current Node.js is ${process.versions.node}.`,
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

function setupLooksComplete(releaseBundle) {
  if (!existsSync(join(rootDir, 'node_modules', '.pnpm'))) {
    return false;
  }
  if (releaseBundle) {
    return existsSync(join(rootDir, 'node_modules', 'fastify', 'package.json'));
  }
  return buildTargets.every((target) => {
    const packageDir = target.replace(/^@current\//, '');
    return existsSync(join(rootDir, 'packages', packageDir, 'dist'));
  });
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
  if (commandWorks(corepack)) {
    spawnSync(corepack, ['enable'], {
      cwd: rootDir,
      stdio: 'ignore',
      shell: false,
    });
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

  throw new Error(
    `Could not run pnpm@${pnpmVersion}. Install Node.js ${minimumNodeMajor}+ with npm/npx, enable corepack, or install pnpm ${pnpmVersion}.`,
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

  if (!reinstallRequested && setupLooksComplete(releaseBundle)) {
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
