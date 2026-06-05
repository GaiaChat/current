import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((entry) => entry.trim().length > 0);
  }
  return undefined;
}

export function firstCsvHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = firstHeaderValue(value);
  return first?.split(',')[0]?.trim() || undefined;
}

export function isLoopbackHostname(value: string): boolean {
  const hostname = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (hostname === 'localhost' || hostname === '::1') {
    return true;
  }
  if (isIP(hostname) !== 4) {
    return false;
  }
  const [firstOctet] = hostname.split('.').map((segment) => Number(segment));
  return firstOctet === 127;
}

export function normalizeOriginUrl(url: URL): string {
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function normalizeHttpOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http:// or https://.');
  }
  return normalizeOriginUrl(parsed);
}

export function normalizeLoopbackOriginPort(url: URL, serverPort: number): URL {
  if (isLoopbackHostname(url.hostname)) {
    url.port = String(serverPort);
  }
  return url;
}

export function deriveRequestOrigin(
  request: FastifyRequest,
  input: {
    serverPort: number;
    fallbackPublicUrl: string;
  },
): string {
  const forwardedProto = firstCsvHeaderValue(request.headers['x-forwarded-proto'])?.toLowerCase();
  const protocol =
    forwardedProto === 'http' || forwardedProto === 'https'
      ? `${forwardedProto}:`
      : `${request.protocol}:`;
  const host =
    firstCsvHeaderValue(request.headers['x-forwarded-host']) ??
    firstHeaderValue(request.headers.host);

  if (host) {
    try {
      return normalizeOriginUrl(
        normalizeLoopbackOriginPort(new URL(`${protocol}//${host}`), input.serverPort),
      );
    } catch {
      // Fall back to configured URL below.
    }
  }

  try {
    return normalizeOriginUrl(
      normalizeLoopbackOriginPort(new URL(input.fallbackPublicUrl), input.serverPort),
    );
  } catch {
    return `http://127.0.0.1:${input.serverPort}`;
  }
}

export function buildDefaultOAuthRedirectUri(publicUrl: string): string {
  const redirect = new URL(publicUrl);
  redirect.pathname = '/api/v1/auth/oauth/callback';
  redirect.search = '';
  redirect.hash = '';
  return redirect.toString();
}

export function deriveDiscoverableClientIdFromPublicUrl(publicUrl: string): string | null {
  try {
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '::1' || isIP(parsed.hostname)) {
      return null;
    }
    if (!parsed.hostname.includes('.') || parsed.hostname.endsWith('.local')) {
      return null;
    }
    return new URL('/api/v1/auth/client-metadata.json', parsed).toString();
  } catch {
    return null;
  }
}

export function isGeneratedOAuthRedirectForPublicUrl(redirectUri: string, publicUrl: string): boolean {
  try {
    return new URL(redirectUri).toString() === buildDefaultOAuthRedirectUri(publicUrl);
  } catch {
    return false;
  }
}

export function isGeneratedDiscoverableClientIdForPublicUrl(clientId: string, publicUrl: string): boolean {
  const generated = deriveDiscoverableClientIdFromPublicUrl(publicUrl);
  return Boolean(generated && clientId === generated);
}
