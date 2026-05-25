import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | undefined;

function readJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readReleaseInfoVersion(rootDir: string): string | null {
  const parsed = readJson(join(rootDir, 'release-info.json'));
  const version = parsed?.version;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

function readRootPackageVersion(rootDir: string): string | null {
  const parsed = readJson(join(rootDir, 'package.json'));
  const name = parsed?.name;
  const version = parsed?.version;
  if (
    (name !== 'current' && name !== 'current-server-release') ||
    typeof version !== 'string' ||
    !version.trim()
  ) {
    return null;
  }
  return version.trim();
}

function getCandidateRootDirs(): string[] {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  return Array.from(new Set([process.cwd(), moduleRoot]));
}

export function getServerVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const envVersion = process.env.CURRENT_SERVER_VERSION?.trim();
  if (envVersion) {
    cachedVersion = envVersion;
    return cachedVersion;
  }

  for (const rootDir of getCandidateRootDirs()) {
    const version = readReleaseInfoVersion(rootDir);
    if (version) {
      cachedVersion = version;
      return cachedVersion;
    }
  }

  for (const rootDir of getCandidateRootDirs()) {
    const version = readRootPackageVersion(rootDir);
    if (version) {
      cachedVersion = version;
      return cachedVersion;
    }
  }

  cachedVersion = 'dev';
  return cachedVersion;
}
