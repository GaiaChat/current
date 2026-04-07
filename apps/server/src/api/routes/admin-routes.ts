import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RegistrationMode } from '@current/types';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasServerPermission } from '../permission-guard.js';

const AdminSettingsPatchSchema = z
  .object({
    registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']).optional(),
    klipyApiKey: z.string().max(512).optional(),
    tenorApiKey: z.string().max(512).optional(),
    lanRedirectBaseUrl: z.string().trim().max(1024).optional(),
  })
  .refine(
    (value) =>
      value.registrationMode !== undefined ||
      value.klipyApiKey !== undefined ||
      value.tenorApiKey !== undefined ||
      value.lanRedirectBaseUrl !== undefined,
    {
      message: 'At least one setting must be provided.',
    },
  );

const OwnershipTransferSchema = z.object({
  targetUserId: z.string().min(1),
});

function ensureManageServerPermission(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  serverId: string,
): boolean {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'Unauthorized.' });
    return false;
  }

  if (!hasServerPermission(app.appContext, {
    serverId,
    user: request.currentUser,
    permission: 'MANAGE_SERVER',
  })) {
    denyForbidden(reply, 'MANAGE_SERVER');
    return false;
  }

  return true;
}

function moderationSummary(type: string, targetUserId: string, reason?: string): string {
  const verbMap: Record<string, string> = {
    ban: 'Banned',
    mute: 'Muted',
    timeout: 'Timed out',
    kick: 'Kicked',
    warn: 'Warned',
  };
  const verb = verbMap[type] ?? type;
  return `${verb} ${targetUserId}${reason ? ` (${reason})` : ''}`;
}

function normalizeRegistrationMode(mode: string): RegistrationMode {
  if (mode === 'open_signup' || mode === 'manual_approval') {
    return mode;
  }
  return 'invite_only';
}

function isValidLanRedirectBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/settings', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    const config = app.appContext.serverConfig.get();
    reply.send({
      server: {
        name: config.server.name,
        slug: config.server.slug,
        publicUrl: config.server.publicUrl,
        registrationMode: normalizeRegistrationMode(config.server.registrationMode),
      },
      auth: {
        lanRedirectBaseUrl: config.auth.lanRedirectBaseUrl,
      },
      media: {
        klipyApiKey: config.media.klipyApiKey,
        klipyApiKeyConfigured: config.media.klipyApiKey.trim().length > 0,
        tenorApiKey: config.media.klipyApiKey,
        tenorApiKeyConfigured: config.media.klipyApiKey.trim().length > 0,
      },
      ownership: {
        ownerUserId: app.appContext.setup.getOwnerUserId() ?? undefined,
      },
    });
  });

  app.patch('/admin/settings', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const body = AdminSettingsPatchSchema.safeParse(request.body);

    if (!status.serverId || !request.currentUser || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    if (
      body.data.lanRedirectBaseUrl !== undefined &&
      !isValidLanRedirectBaseUrl(body.data.lanRedirectBaseUrl)
    ) {
      reply.code(400).send({
        error: 'LAN redirect base URL must be empty or a valid http(s) URL.',
      });
      return;
    }

    const next = app.appContext.serverConfig.patchAdminSettings({
      registrationMode: body.data.registrationMode,
      klipyApiKey: body.data.klipyApiKey ?? body.data.tenorApiKey,
      lanRedirectBaseUrl: body.data.lanRedirectBaseUrl,
    });
    if (body.data.registrationMode) {
      app.appContext.db
        .prepare('UPDATE servers SET registration_mode = ? WHERE id = ?')
        .run(body.data.registrationMode, status.serverId);
    }

    reply.send({
      server: {
        name: next.server.name,
        slug: next.server.slug,
        publicUrl: next.server.publicUrl,
        registrationMode: next.server.registrationMode,
      },
      auth: {
        lanRedirectBaseUrl: next.auth.lanRedirectBaseUrl,
      },
      media: {
        klipyApiKey: next.media.klipyApiKey,
        klipyApiKeyConfigured: next.media.klipyApiKey.trim().length > 0,
        tenorApiKey: next.media.klipyApiKey,
        tenorApiKeyConfigured: next.media.klipyApiKey.trim().length > 0,
      },
      ownership: {
        ownerUserId: app.appContext.setup.getOwnerUserId() ?? undefined,
      },
    });
  });

  app.post('/admin/ownership/transfer', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const body = OwnershipTransferSchema.safeParse(request.body);
    if (!status.serverId || !request.currentUser || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    try {
      const owner = app.appContext.setup.transferOwnership({
        serverId: status.serverId,
        actorId: request.currentUser.id,
        targetUserId: body.data.targetUserId,
      });
      reply.send({
        ownerUserId: owner.id,
      });
    } catch (error) {
      reply.code(400).send({
        error: error instanceof Error ? error.message : 'Ownership transfer failed.',
      });
    }
  });

  app.get('/admin/moderation/logs', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(request.query);
    if (!status.serverId || !request.currentUser || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    const limit = query.data.limit ?? 150;
    const modActions = app.appContext.moderation.listActions(status.serverId).map((action) => ({
      id: `mod:${action.id}`,
      source: 'moderation' as const,
      action: action.type,
      actorId: action.actorId,
      targetId: action.targetUserId,
      createdAt: action.createdAt,
      summary: moderationSummary(action.type, action.targetUserId, action.reason),
      payload: {
        reason: action.reason,
        expiresAt: action.expiresAt,
      },
    }));

    const auditLogs = app.appContext.moderation.listAuditLogs(status.serverId, Math.max(limit * 2, 300)).map((log) => ({
      id: `audit:${log.id}`,
      source: 'audit' as const,
      action: log.action,
      actorId: log.actorId,
      targetId: log.targetId,
      createdAt: log.createdAt,
      summary: log.action,
      payload: log.payload,
    }));

    const feed = [...modActions, ...auditLogs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    reply.send(feed);
  });

  app.get('/admin/shared-ips', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    reply.send(app.appContext.members.listSharedIpGroups());
  });
}
