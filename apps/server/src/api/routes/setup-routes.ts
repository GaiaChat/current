import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { z } from 'zod';
import { MAX_CONFIGURABLE_ATTACHMENT_BYTES } from '@current/config';

const BootstrapSchema = z.object({
  serverName: z.string().min(2),
  slug: z.string().min(2),
  publicUrl: z.string().url().optional(),
  registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']),
  initialPresenceStatus: z.enum(['online', 'away', 'dnd', 'invisible']).optional(),
  media: z
    .object({
      gifProvider: z.enum(['klipy', 'giphy']).optional(),
      gifFallbackProvider: z.enum(['none', 'klipy', 'giphy']).optional(),
      klipyApiKey: z.string().max(512).optional(),
      giphyApiKey: z.string().max(512).optional(),
      maxAttachmentBytes: z
        .number()
        .int()
        .positive()
        .max(MAX_CONFIGURABLE_ATTACHMENT_BYTES)
        .optional(),
      allowedMimePrefixes: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    })
    .optional(),
  moderation: z
    .object({
      defaultSlowmodeSeconds: z.number().int().min(0).max(86_400).optional(),
      maxMentionsPerMessage: z.number().int().min(1).max(500).optional(),
      linkPolicy: z.enum(['allow', 'members_only', 'deny']).optional(),
    })
    .optional(),
  adminDid: z.string().optional(),
  adminHandle: z.string().optional(),
  adminDisplayName: z.string().optional(),
  adminAvatarUrl: z.string().optional(),
});

function normalizeIpAddress(value: string): string {
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function isLoopbackIpAddress(value: string): boolean {
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

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstCsvHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = firstHeaderValue(value);
  return first?.split(',')[0]?.trim() || undefined;
}

function isLoopbackHostname(value: string): boolean {
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

function normalizeOriginUrl(url: URL): string {
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeLoopbackOriginPort(url: URL, serverPort: number): URL {
  if (isLoopbackHostname(url.hostname)) {
    url.port = String(serverPort);
  }
  return url;
}

function deriveSetupPublicUrl(
  request: FastifyRequest,
  serverPort: number,
  fallbackPublicUrl: string,
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
      const origin = normalizeLoopbackOriginPort(new URL(`${protocol}//${host}`), serverPort);
      return normalizeOriginUrl(origin);
    } catch {
      // Fall back to the configured URL below.
    }
  }

  try {
    const fallback = normalizeLoopbackOriginPort(new URL(fallbackPublicUrl), serverPort);
    return normalizeOriginUrl(fallback);
  } catch {
    return `http://127.0.0.1:${serverPort}`;
  }
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/setup/status', async () => {
    return app.appContext.setup.status();
  });

  app.post('/setup/bootstrap', async (request, reply) => {
    const parsed = BootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    try {
      const currentUser = request.currentUser;
      if (!currentUser && (!isLoopbackIpAddress(request.ip) || request.headers.origin)) {
        reply.code(401).send({
          error: {
            code: 'SETUP_AUTH_REQUIRED',
            message: 'First-run setup must be completed by a signed-in user.',
          },
        });
        return;
      }
      const config = app.appContext.serverConfig.get();
      const publicUrl = deriveSetupPublicUrl(request, config.server.port, config.server.publicUrl);
      const payload = currentUser
        ? {
            ...parsed.data,
            publicUrl,
            adminDid: currentUser.did,
            adminHandle: currentUser.handle,
            adminDisplayName: currentUser.displayName,
            adminAvatarUrl: currentUser.avatarUrl,
          }
        : {
            ...parsed.data,
            publicUrl,
          };

      const result = app.appContext.setup.bootstrap(payload);
      reply.code(201).send(result);
    } catch (error) {
      reply.code(409).send({
        error: {
          code: 'SETUP_CONFLICT',
          message: error instanceof Error ? error.message : 'Unable to bootstrap setup.',
        },
      });
    }
  });
}
