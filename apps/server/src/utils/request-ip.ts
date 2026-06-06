import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { FastifyRequest } from 'fastify';
import { firstHeaderValue } from './request-url.js';

export function normalizeIpAddress(value: string): string {
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

export function isLoopbackIpAddress(value: string): boolean {
  const normalized = normalizeIpAddress(value);
  if (normalized === '::1' || normalized === '127.0.0.1') {
    return true;
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  const [firstOctet] = normalized.split('.').map((segment) => Number(segment));
  return firstOctet === 127;
}

function normalizeIpCandidate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPort = trimmed.startsWith('[')
    ? trimmed.slice(1, trimmed.indexOf(']') > 0 ? trimmed.indexOf(']') : undefined)
    : trimmed.replace(/:\d+$/, '');
  return normalizeIpAddress(withoutPort);
}

function collectHostIps(): Set<string> {
  const ips = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      ips.add(normalizeIpAddress(entry.address));
    }
  }
  return ips;
}

export function resolveOriginatingRequestIp(request: FastifyRequest): string {
  const normalizedRemote = normalizeIpAddress(request.ip);
  const trustProxySetting = (request.server as { initialConfig?: { trustProxy?: unknown } })
    .initialConfig?.trustProxy;
  const trustProxyEnabled = Boolean(trustProxySetting);
  const trustProxyViaLoopback = isLoopbackIpAddress(normalizedRemote);
  const shouldTrustForwardedHeaders = trustProxyEnabled || trustProxyViaLoopback;

  if (shouldTrustForwardedHeaders) {
    const forwardedFor = firstHeaderValue(request.headers['x-forwarded-for']);
    if (forwardedFor) {
      const [firstHop] = forwardedFor.split(',');
      const normalizedForwarded = normalizeIpCandidate(firstHop ?? '');
      if (normalizedForwarded && normalizedForwarded.toLowerCase() !== 'unknown') {
        return normalizedForwarded;
      }
    }

    const realIp = firstHeaderValue(request.headers['x-real-ip']);
    if (realIp) {
      const normalizedRealIp = normalizeIpCandidate(realIp);
      if (normalizedRealIp && normalizedRealIp.toLowerCase() !== 'unknown') {
        return normalizedRealIp;
      }
    }
  }

  return normalizedRemote;
}

export function isRequestFromHostMachine(request: FastifyRequest): boolean {
  const normalizedRemote = resolveOriginatingRequestIp(request);
  if (isLoopbackIpAddress(normalizedRemote)) {
    return true;
  }

  return collectHostIps().has(normalizedRemote);
}
