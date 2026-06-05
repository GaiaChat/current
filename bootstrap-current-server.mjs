#!/usr/bin/env node

const defaultPort = process.env.CURRENT_PORT || process.env.CURRENT_SERVER_PORT || '6414';

function usage() {
  return [
    'Usage: node bootstrap-current-server.mjs --public-url <url> [options]',
    '',
    'Runs first-time setup from the server host, which is useful over SSH or on cloud VMs.',
    'Start Current first, then run this helper on the same machine.',
    '',
    'Options:',
    '  --url <url>                    Local API base. Default: http://127.0.0.1:<port>',
    '  --port <port>                  Local server port. Default: CURRENT_PORT or 6414.',
    '  --public-url <url>             Public origin users will open, such as https://chat.example.com.',
    '  --server-name <name>           Server display name. Default: Current Server.',
    '  --slug <slug>                  Server slug. Default: generated from server name.',
    '  --registration-mode <mode>     invite_only, open_signup, or manual_approval. Default: invite_only.',
    '  --initial-presence <status>    online, away, dnd, or invisible.',
    '  --admin-did <did>              Optional first owner DID.',
    '  --admin-handle <handle>        Optional first owner handle.',
    '  --admin-display-name <name>    Optional first owner display name.',
    '  --admin-avatar-url <url>       Optional first owner avatar URL.',
    '  --owner-code                   Generate a terminal owner verification code.',
    '  --status                       Only print setup status.',
  ].join('\n');
}

function normalizePort(value) {
  const port = Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}". Use a number from 1 to 65535.`);
  }
  return port;
}

function normalizeOriginUrl(label, value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid ${label} "${trimmed}". Use a full http:// or https:// URL.`);
  }
}

function normalizeRegistrationMode(value) {
  const mode = String(value || 'invite_only').trim();
  if (!['invite_only', 'open_signup', 'manual_approval'].includes(mode)) {
    throw new Error(
      `Invalid registration mode "${value}". Use invite_only, open_signup, or manual_approval.`,
    );
  }
  return mode;
}

function normalizePresence(value) {
  const status = String(value || '').trim();
  if (!status) {
    return undefined;
  }
  if (!['online', 'away', 'dnd', 'invisible'].includes(status)) {
    throw new Error(`Invalid presence "${value}". Use online, away, dnd, or invisible.`);
  }
  return status;
}

function slugify(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'current-server';
}

function readOption(args, index) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}.`);
  }
  return value;
}

function parseArgs() {
  const options = {
    apiUrl: '',
    port: normalizePort(defaultPort),
    publicUrl: '',
    serverName: 'Current Server',
    slug: '',
    registrationMode: 'invite_only',
    initialPresenceStatus: undefined,
    adminDid: '',
    adminHandle: '',
    adminDisplayName: '',
    adminAvatarUrl: '',
    ownerCode: false,
    status: false,
  };

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--status') {
      options.status = true;
      continue;
    }
    if (arg === '--owner-code') {
      options.ownerCode = true;
      continue;
    }
    if (arg === '--url') {
      options.apiUrl = normalizeOriginUrl('URL', readOption(args, index));
      index += 1;
      continue;
    }
    if (arg === '--port') {
      options.port = normalizePort(readOption(args, index));
      index += 1;
      continue;
    }
    if (arg === '--public-url') {
      options.publicUrl = normalizeOriginUrl('public URL', readOption(args, index));
      index += 1;
      continue;
    }
    if (arg === '--server-name') {
      options.serverName = readOption(args, index).trim();
      index += 1;
      continue;
    }
    if (arg === '--slug') {
      options.slug = readOption(args, index).trim();
      index += 1;
      continue;
    }
    if (arg === '--registration-mode') {
      options.registrationMode = normalizeRegistrationMode(readOption(args, index));
      index += 1;
      continue;
    }
    if (arg === '--initial-presence') {
      options.initialPresenceStatus = normalizePresence(readOption(args, index));
      index += 1;
      continue;
    }
    if (arg === '--admin-did') {
      options.adminDid = readOption(args, index).trim();
      index += 1;
      continue;
    }
    if (arg === '--admin-handle') {
      options.adminHandle = readOption(args, index).trim();
      index += 1;
      continue;
    }
    if (arg === '--admin-display-name') {
      options.adminDisplayName = readOption(args, index).trim();
      index += 1;
      continue;
    }
    if (arg === '--admin-avatar-url') {
      options.adminAvatarUrl = readOption(args, index).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--url=')) {
      options.apiUrl = normalizeOriginUrl('URL', arg.slice('--url='.length));
      continue;
    }
    if (arg.startsWith('--port=')) {
      options.port = normalizePort(arg.slice('--port='.length));
      continue;
    }
    if (arg.startsWith('--public-url=')) {
      options.publicUrl = normalizeOriginUrl('public URL', arg.slice('--public-url='.length));
      continue;
    }
    if (arg.startsWith('--server-name=')) {
      options.serverName = arg.slice('--server-name='.length).trim();
      continue;
    }
    if (arg.startsWith('--slug=')) {
      options.slug = arg.slice('--slug='.length).trim();
      continue;
    }
    if (arg.startsWith('--registration-mode=')) {
      options.registrationMode = normalizeRegistrationMode(
        arg.slice('--registration-mode='.length),
      );
      continue;
    }
    if (arg.startsWith('--initial-presence=')) {
      options.initialPresenceStatus = normalizePresence(arg.slice('--initial-presence='.length));
      continue;
    }
    if (arg.startsWith('--admin-did=')) {
      options.adminDid = arg.slice('--admin-did='.length).trim();
      continue;
    }
    if (arg.startsWith('--admin-handle=')) {
      options.adminHandle = arg.slice('--admin-handle='.length).trim();
      continue;
    }
    if (arg.startsWith('--admin-display-name=')) {
      options.adminDisplayName = arg.slice('--admin-display-name='.length).trim();
      continue;
    }
    if (arg.startsWith('--admin-avatar-url=')) {
      options.adminAvatarUrl = arg.slice('--admin-avatar-url='.length).trim();
      continue;
    }
    throw new Error(`Unknown option ${arg}.\n\n${usage()}`);
  }

  options.apiUrl ||= `http://127.0.0.1:${options.port}`;
  options.slug ||= slugify(options.serverName);
  if (!options.status && !options.serverName.trim()) {
    throw new Error('Server name cannot be empty.');
  }
  const ownerFields = [options.adminDid, options.adminHandle, options.adminDisplayName];
  if (ownerFields.some(Boolean) && !ownerFields.every(Boolean)) {
    throw new Error(
      'Preseeded owner setup requires --admin-did, --admin-handle, and --admin-display-name together.',
    );
  }
  return options;
}

function setupHeaders(publicUrl) {
  if (!publicUrl) {
    return {};
  }
  const parsed = new URL(publicUrl);
  return {
    'x-forwarded-proto': parsed.protocol.replace(/:$/, ''),
    'x-forwarded-host': parsed.host,
  };
}

async function apiRequest(apiUrl, path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text } };
    }
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.error?.code || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function printStatus(status) {
  console.log(`[Current bootstrap] Configured: ${status.configured ? 'yes' : 'no'}`);
  console.log(`[Current bootstrap] Public URL: ${status.network?.publicUrl ?? 'unknown'}`);
  console.log(`[Current bootstrap] Port: ${status.network?.port ?? 'unknown'}`);
  if (status.server) {
    console.log(`[Current bootstrap] Server: ${status.server.name}`);
    console.log(`[Current bootstrap] Registration: ${status.server.registrationMode}`);
  }
  if (status.ownership) {
    console.log(`[Current bootstrap] Owner assigned: ${status.ownership.ownerUserId ? 'yes' : 'no'}`);
    console.log(
      `[Current bootstrap] Owner code active: ${status.ownership.verificationCodeActive ? 'yes' : 'no'}`,
    );
  }
}

async function main() {
  const options = parseArgs();
  const apiUrl = normalizeOriginUrl('URL', options.apiUrl);
  console.log(`[Current bootstrap] API: ${apiUrl}`);

  const status = await apiRequest(apiUrl, '/api/v1/setup/status');
  if (options.status) {
    printStatus(status);
    return;
  }
  if (options.ownerCode) {
    const result = await apiRequest(apiUrl, '/api/v1/setup/owner/code', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    console.log(`[Current bootstrap] Owner verification code: ${result.ownerVerificationCode}`);
    console.log(`[Current bootstrap] Expires at: ${result.expiresAt}`);
    console.log('[Current bootstrap] Sign in from your browser and enter this code to claim owner/admin.');
    return;
  }
  if (status.configured) {
    printStatus(status);
    console.log('[Current bootstrap] Setup is already complete. No changes made.');
    return;
  }

  const payload = {
    serverName: options.serverName.trim(),
    slug: options.slug,
    publicUrl: options.publicUrl || undefined,
    registrationMode: options.registrationMode,
    initialPresenceStatus: options.initialPresenceStatus,
    adminDid: options.adminDid || undefined,
    adminHandle: options.adminHandle || undefined,
    adminDisplayName: options.adminDisplayName || undefined,
    adminAvatarUrl: options.adminAvatarUrl || undefined,
  };

  const result = await apiRequest(apiUrl, '/api/v1/setup/bootstrap', {
    method: 'POST',
    headers: setupHeaders(options.publicUrl),
    body: JSON.stringify(payload),
  });

  console.log('[Current bootstrap] Setup complete.');
  console.log(`[Current bootstrap] Server ID: ${result.serverId}`);
  console.log(`[Current bootstrap] Default channel ID: ${result.defaultChannelId}`);
  console.log(
    `[Current bootstrap] Open ${options.publicUrl || apiUrl} and sign in. If no owner was preseeded, run this helper with --owner-code and enter that code in the browser to claim owner/admin.`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Current bootstrap] ${message}`);
  console.error(
    '[Current bootstrap] Make sure Current is running and run this helper on the server host or over SSH.',
  );
  process.exit(1);
});
