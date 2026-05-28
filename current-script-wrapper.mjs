#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { printGaiaChatBanner } from './gaia-chat-banner.mjs';

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

function filteredArgs() {
  return process.argv.slice(2).filter((arg) => arg !== '--no-pause' && arg !== '--');
}

function shouldPause(pause, exitCode) {
  if (process.argv.includes('--no-pause') || !process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  return pause === 'always' || (pause === 'error' && exitCode !== 0);
}

async function waitForEnter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('Press Enter/Return to close this window.');
  } finally {
    rl.close();
  }
}

function exitLabel(result) {
  return result.signal || `exit code ${result.code ?? 1}`;
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', rejectRun);
    child.on('close', (code, signal) => resolveRun({ code, signal }));
  });
}

export async function runCurrentScript(options) {
  const scriptPath = join(rootDir, options.script);
  const args = [...(options.defaultArgs ?? []), ...filteredArgs()];
  const helpRequested = args.includes('--help') || args.includes('-h');
  if (options.banner && !helpRequested) {
    printGaiaChatBanner(rootDir);
  }
  const result = await runNodeScript(scriptPath, args);
  const exitCode = result.code ?? (result.signal ? 1 : 0);

  if (!helpRequested && options.successMessage && exitCode === 0) {
    console.log('');
    console.log(options.successMessage);
  } else if (!helpRequested && options.failurePrefix && exitCode !== 0) {
    console.log('');
    console.log(`${options.failurePrefix} ${exitLabel(result)}.`);
  }

  if (!helpRequested && shouldPause(options.pause ?? 'never', exitCode)) {
    if (!options.successMessage && !options.failurePrefix) {
      console.log('');
    }
    await waitForEnter();
  }

  process.exitCode = exitCode;
}
