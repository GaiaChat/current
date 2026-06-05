import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CurrentConfig } from '@current/config';
import { firstCsvHeaderValue, firstHeaderValue } from '../utils/request-url.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_DEV_PORTS = new Set(['5173', '4173']);

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseHostHeader(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  return parseHttpUrl(`http://${value}`);
}

function requestHostHeader(request: FastifyRequest): string | undefined {
  return firstCsvHeaderValue(request.headers['x-forwarded-host']) ?? firstHeaderValue(request.headers.host);
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') {
    return true;
  }
  if (isIP(hostname) !== 4) {
    return false;
  }
  const [firstOctet] = hostname.split('.').map((segment) => Number(segment));
  return firstOctet === 127;
}

function configuredOrigins(config: CurrentConfig): Set<string> {
  const origins = new Set<string>();
  for (const candidate of [config.server.publicUrl, config.auth.lanRedirectBaseUrl]) {
    const parsed = candidate ? parseHttpUrl(candidate) : null;
    if (parsed) {
      origins.add(parsed.origin);
    }
  }
  return origins;
}

function isAllowedLoopbackDevOrigin(origin: URL): boolean {
  return isLoopbackHost(origin.hostname) && LOOPBACK_DEV_PORTS.has(origin.port);
}

function isAllowedAbsoluteOrigin(input: {
  origin: URL;
  requestHost?: string;
  config: CurrentConfig;
}): boolean {
  const requestHost = parseHostHeader(input.requestHost);
  if (requestHost && input.origin.host.toLowerCase() === requestHost.host.toLowerCase()) {
    return true;
  }

  if (configuredOrigins(input.config).has(input.origin.origin)) {
    return true;
  }

  if (requestHost && isLoopbackHost(requestHost.hostname) && isAllowedLoopbackDevOrigin(input.origin)) {
    return true;
  }

  return false;
}

export function isAllowedRequestOrigin(input: {
  origin?: string | string[];
  host?: string | string[];
  config: CurrentConfig;
}): boolean {
  const rawOrigin = firstHeaderValue(input.origin);
  if (!rawOrigin) {
    return true;
  }

  const origin = parseHttpUrl(rawOrigin);
  if (!origin) {
    return false;
  }

  return isAllowedAbsoluteOrigin({
    origin,
    requestHost: firstHeaderValue(input.host),
    config: input.config,
  });
}

export function isAllowedCorsOrigin(origin: string | undefined, config: CurrentConfig): boolean {
  if (!origin) {
    return true;
  }

  const parsed = parseHttpUrl(origin);
  if (!parsed) {
    return false;
  }

  return configuredOrigins(config).has(parsed.origin) || isAllowedLoopbackDevOrigin(parsed);
}

export function isSafeAuthRedirectTarget(input: {
  target: URL;
  requestHost?: string | string[];
  config: CurrentConfig;
}): boolean {
  return isAllowedAbsoluteOrigin({
    origin: input.target,
    requestHost: firstHeaderValue(input.requestHost),
    config: input.config,
  });
}

export async function rejectDisallowedBrowserOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return;
  }

  if (isAllowedRequestOrigin({
    origin: request.headers.origin,
    host: requestHostHeader(request),
    config: request.server.appContext.serverConfig.get(),
  })) {
    return;
  }

  reply.code(403).send({
    error: {
      code: 'ORIGIN_NOT_ALLOWED',
      message: 'This browser origin is not allowed to use the Current API.',
    },
  });
}
