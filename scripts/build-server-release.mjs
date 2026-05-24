#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
const version = process.env.CURRENT_SERVER_RELEASE_VERSION || packageJson.version;
const channel = process.env.CURRENT_SERVER_RELEASE_CHANNEL || 'stable';
const releaseRepository = process.env.CURRENT_SERVER_RELEASE_REPOSITORY || 'GaiaChat/current';
const releaseBaseUrl =
  process.env.CURRENT_SERVER_RELEASE_BASE_URL ||
  `https://github.com/${releaseRepository}/releases/latest/download`;
const releaseDir = resolve(rootDir, process.env.CURRENT_SERVER_RELEASE_DIR || 'release-server');
const stageRoot = join(releaseDir, '.stage');
const bundleName = `current-server-v${version}`;
const bundleDir = join(stageRoot, bundleName);
const archiveName = `${bundleName}.tar.gz`;
const archivePath = join(releaseDir, archiveName);
const manifestName = channel === 'stable'
  ? 'current-server-latest.json'
  : `current-server-${channel}.json`;
const manifestPath = join(releaseDir, manifestName);
const skipBuild = process.argv.includes('--skip-build');

function run(command, args, label) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: rootDir,
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

async function copyPath(relativePath) {
  const source = join(rootDir, relativePath);
  const target = join(bundleDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
}

async function rewriteWorkspacePackageForProduction(relativePackageJsonPath) {
  const packageJsonPath = join(bundleDir, relativePackageJsonPath);
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const nextManifest = {
    ...manifest,
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    },
  };

  await writeFile(packageJsonPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
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

function releaseAssetUrl(fileName) {
  return `${releaseBaseUrl.replace(/\/+$/, '')}/${fileName}`;
}

async function build() {
  if (skipBuild) {
    console.log('[Current release] Skipping build because --skip-build was passed.');
    return;
  }

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const buildTargets = [
    '@current/types',
    '@current/protocol',
    '@current/config',
    '@current/ui',
    '@current/web',
    '@current/server',
  ];

  for (const target of buildTargets) {
    await run(pnpm, ['--filter', target, 'build'], `${target} build`);
  }
}

async function stageBundle() {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });

  const paths = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'turbo.json',
    'README.md',
    'assets',
    'deploy/current.service',
    'scripts/install-current.sh',
    'scripts/start-current-server.mjs',
    'scripts/update-current-server.mjs',
    'apps/server/package.json',
    'apps/server/tsconfig.json',
    'apps/server/dist',
    'apps/server/src',
    'apps/web/package.json',
    'apps/web/index.html',
    'apps/web/public',
    'apps/web/src',
    'apps/web/tsconfig.json',
    'apps/web/vite.config.ts',
    'apps/web/dist',
    'packages/config/package.json',
    'packages/config/tsconfig.json',
    'packages/config/dist',
    'packages/config/src',
    'packages/protocol/package.json',
    'packages/protocol/tsconfig.json',
    'packages/protocol/dist',
    'packages/protocol/src',
    'packages/types/package.json',
    'packages/types/tsconfig.json',
    'packages/types/dist',
    'packages/types/src',
    'packages/ui/package.json',
    'packages/ui/tsconfig.json',
    'packages/ui/dist',
    'packages/ui/src',
  ];

  for (const path of paths) {
    await copyPath(path);
  }

  await rewriteWorkspacePackageForProduction('packages/config/package.json');
  await rewriteWorkspacePackageForProduction('packages/protocol/package.json');
  await rewriteWorkspacePackageForProduction('packages/types/package.json');
  await rewriteWorkspacePackageForProduction('packages/ui/package.json');

  await writeFile(
    join(bundleDir, 'release-info.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      name: 'current-server',
      version,
      channel,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

async function packBundle() {
  await mkdir(releaseDir, { recursive: true });
  await rm(archivePath, { force: true });
  await run('tar', ['-czf', archivePath, '-C', stageRoot, bundleName], 'server release archive');
}

async function writeManifest() {
  const archiveStats = await stat(archivePath);
  const digest = await sha256(archivePath);
  const manifest = {
    schemaVersion: 1,
    name: 'current-server',
    version,
    channel,
    repository: releaseRepository,
    releasedAt: new Date().toISOString(),
    manifestUrl: releaseAssetUrl(manifestName),
    minimumNode: '20.0.0',
    assets: [
      {
        platform: 'linux',
        arch: 'any',
        name: archiveName,
        url: releaseAssetUrl(archiveName),
        sha256: digest,
        size: archiveStats.size,
      },
    ],
    install: {
      preserve: [
        '/etc/current/current.config.json',
        '/var/lib/current/',
        'apps/server/config/',
        'apps/server/data/',
        'apps/server/uploads/',
        'apps/server/backups/',
      ],
      restartRequired: true,
      backupRecommended: true,
    },
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[Current release] Wrote ${basename(archivePath)}`);
  console.log(`[Current release] Wrote ${basename(manifestPath)}`);
}

await build();
await stageBundle();
await packBundle();
await writeManifest();
await rm(stageRoot, { recursive: true, force: true });
