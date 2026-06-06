import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const bannerPrintedEnv = 'CURRENT_GAIA_CHAT_BANNER_PRINTED';

function readManifestVersion(rootDir, fileName) {
  const filePath = join(rootDir, fileName);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

export function readGaiaChatVersion(rootDir) {
  return (
    readManifestVersion(rootDir, 'release-info.json') ??
    readManifestVersion(rootDir, 'package.json') ??
    'dev'
  );
}

export function printGaiaChatBanner(rootDir, env = process.env) {
  if (env[bannerPrintedEnv] === '1') {
    return;
  }

  const versionLine = `Gaia Chat Version ${readGaiaChatVersion(rootDir)}`;
  const boxWidth = Math.max(46, versionLine.length + 6);
  const border = `+${'-'.repeat(boxWidth - 2)}+`;
  const paddedVersion = versionLine.padEnd(boxWidth - 4);

  console.log('  ____       _       ____ _           _');
  console.log(' / ___| __ _(_) __ _/ ___| |__   __ _| |_');
  console.log("| |  _ / _` | |/ _` | |   | '_ \\ / _` | __|");
  console.log('| |_| | (_| | | (_| | |___| | | | (_| | |_');
  console.log(' \\____|\\__,_|_|\\__,_|\\____|_| |_|\\__,_|\\__|');
  console.log(border);
  console.log(`| ${paddedVersion} |`);
  console.log(border);
  console.log('');

  env[bannerPrintedEnv] = '1';
}
