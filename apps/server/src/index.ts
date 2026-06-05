import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  configExists,
  createDefaultConfig,
  loadConfig,
  saveConfig,
  type CurrentConfig,
} from '@current/config';
import { createDb } from './db/client.js';
import { createAppContext } from './create-context.js';
import { buildApp } from './app.js';
import {
  buildDefaultOAuthRedirectUri,
  deriveDiscoverableClientIdFromPublicUrl,
} from './utils/request-url.js';

function normalizeBrowserHost(host: string): string {
  const trimmed = host.trim();
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

function normalizeUrl(value: string, options: { originOnly?: boolean } = {}): string {
  const parsed = new URL(value);
  if (options.originOnly) {
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
  }
  return parsed.toString().replace(/\/$/, '');
}

function parseUrlOverride(
  name: string,
  value: string | undefined,
  options: { originOnly?: boolean } = {},
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return normalizeUrl(trimmed, options);
  } catch {
    throw new Error(`Invalid ${name} "${trimmed}". Use a full http:// or https:// URL.`);
  }
}

function parseHostOverride(): string | null {
  return process.env.CURRENT_HOST?.trim() || process.env.CURRENT_SERVER_HOST?.trim() || null;
}

function buildLocalWebsiteUrl(config: CurrentConfig): string {
  const protocol = config.server.tls.enabled ? 'https' : 'http';
  return `${protocol}://${normalizeBrowserHost(config.server.host)}:${config.server.port}`;
}

function parsePortOverride(): number | null {
  const candidate =
    process.env.CURRENT_PORT?.trim() ||
    process.env.CURRENT_SERVER_PORT?.trim() ||
    process.env.PORT?.trim() ||
    '';
  if (!candidate) {
    return null;
  }

  const port = Number(candidate);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port override "${candidate}". Use a number from 1 to 65535.`);
  }
  return port;
}

function isLoopbackUrl(value: string): boolean {
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

function withPort(value: string, port: number): string {
  const parsed = new URL(value);
  parsed.port = String(port);
  const next = parsed.toString();
  return parsed.pathname === '/' && !parsed.search && !parsed.hash ? next.replace(/\/$/, '') : next;
}

function withLoopbackPort(value: string, port: number): string {
  return isLoopbackUrl(value) ? withPort(value, port) : value;
}

interface RuntimeNetworkOverrides {
  host: string | null;
  publicUrl: string | null;
  redirectUri: string | null;
  rtcAnnouncedIp: string | null;
}

function applyRuntimeNetworkConfig(
  config: CurrentConfig,
  portOverride: number | null,
  overrides: RuntimeNetworkOverrides,
): CurrentConfig {
  const port = portOverride ?? config.server.port;
  const publicUrl = overrides.publicUrl ?? withLoopbackPort(config.server.publicUrl, port);
  const redirectUri =
    overrides.redirectUri ??
    (overrides.publicUrl
      ? buildDefaultOAuthRedirectUri(overrides.publicUrl)
      : withLoopbackPort(config.auth.redirectUri, port));
  const atprotoClientId =
    config.auth.atprotoClientId ||
    (overrides.publicUrl
      ? (deriveDiscoverableClientIdFromPublicUrl(overrides.publicUrl) ?? '')
      : '');
  return createDefaultConfig({
    ...config,
    server: {
      ...config.server,
      host: overrides.host ?? config.server.host,
      port,
      publicUrl,
    },
    auth: {
      ...config.auth,
      atprotoClientId,
      redirectUri,
    },
    rtc: {
      ...config.rtc,
      announcedIp: overrides.rtcAnnouncedIp ?? config.rtc.announcedIp,
    },
  });
}

function logWebsiteUrl(config: CurrentConfig, listenAddress: string): void {
  const publicUrl = config.server.publicUrl;
  const localUrl = buildLocalWebsiteUrl(config);
  console.log(`[server] Website: ${publicUrl}`);
  if (publicUrl.replace(/\/$/, '') !== localUrl.replace(/\/$/, '')) {
    console.log(`[server] Local: ${localUrl}`);
  }
  console.log(`[server] Listening: ${listenAddress}`);
}

function createInitialConfig(): CurrentConfig {
  const instance = process.env.CURRENT_SERVER_INSTANCE?.trim().toLowerCase();
  if (instance !== 'lan') {
    return createDefaultConfig({});
  }

  return createDefaultConfig({
    server: {
      name: 'Current LAN Server',
      slug: 'current-lan-server',
      port: 8081,
      publicUrl: 'http://127.0.0.1:8081',
      registrationMode: 'open_signup',
    },
    auth: {
      mode: 'lan',
      redirectUri: 'http://127.0.0.1:8081/api/v1/auth/oauth/callback',
      cookieSecret: 'change-me-super-secret-lan-cookie-key-please',
    },
    storage: {
      sqlitePath: 'apps/server/data/lan/current.sqlite',
      uploadDir: 'apps/server/uploads/lan',
    },
    rtc: {
      udpMinPort: 40101,
      udpMaxPort: 40200,
    },
  });
}

async function main() {
  const configPath =
    process.env.CURRENT_CONFIG_PATH ?? join(process.cwd(), 'config/current.config.json');
  const portOverride = parsePortOverride();
  const networkOverrides: RuntimeNetworkOverrides = {
    host: parseHostOverride(),
    publicUrl: parseUrlOverride('CURRENT_PUBLIC_URL', process.env.CURRENT_PUBLIC_URL, {
      originOnly: true,
    }),
    redirectUri: parseUrlOverride(
      'CURRENT_AUTH_REDIRECT_URI',
      process.env.CURRENT_AUTH_REDIRECT_URI,
    ),
    rtcAnnouncedIp: process.env.CURRENT_RTC_ANNOUNCED_IP?.trim() || null,
  };

  if (!configExists(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    const defaultConfig = createInitialConfig();
    saveConfig(configPath, defaultConfig);
  }

  const config = applyRuntimeNetworkConfig(loadConfig(configPath), portOverride, networkOverrides);
  const db = createDb(config.storage.sqlitePath);
  const context = createAppContext({
    db,
    config,
    configPath,
  });

  const app = buildApp(context);

  const ownerCode = context.setup.ensureOwnerVerificationCodeIfNeeded();
  if (ownerCode) {
    console.log('[server] Owner verification required.');
    console.log(`[server] Owner verification code: ${ownerCode.code}`);
    console.log(`[server] Code expires at: ${ownerCode.expiresAt}`);
  }

  const host = config.server.host;
  const port = config.server.port;

  const listenAddress = await app.listen({
    host,
    port,
  });

  logWebsiteUrl(config, listenAddress);
  if (portOverride) {
    console.log(`[server] Port override active: ${portOverride}`);
  }
  if (networkOverrides.host) {
    console.log(`[server] Host override active: ${networkOverrides.host}`);
  }
  if (networkOverrides.publicUrl) {
    console.log(`[server] Public URL override active: ${networkOverrides.publicUrl}`);
  }
  if (networkOverrides.rtcAnnouncedIp) {
    console.log(`[server] RTC announced IP override active: ${networkOverrides.rtcAnnouncedIp}`);
  }
  app.log.info(`Current server running at ${config.server.publicUrl}`);

  const shutdown = async (signal: string) => {
    app.log.info(`Shutting down due to ${signal}`);
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
