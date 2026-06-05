import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_CONFIGURABLE_ATTACHMENT_BYTES } from '@current/config';
import { isRequestFromHostMachine } from '../../utils/request-ip.js';
import {
  deriveRequestOrigin,
  normalizeHttpOrigin,
} from '../../utils/request-url.js';

const BootstrapSchema = z.object({
  serverName: z.string().min(2),
  slug: z.string().min(2),
  publicUrl: z.string().url().optional(),
  serverAddress: z.string().url().optional(),
  ownerVerificationCode: z.string().trim().min(1).max(32).optional(),
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

const OwnerClaimSchema = z.object({
  ownerVerificationCode: z.string().trim().min(1).max(32),
});

const AcmeIssueSchema = z.object({
  email: z.string().trim().max(320).optional(),
  domain: z.string().trim().max(255).optional(),
  directoryUrl: z.string().trim().url().max(2048).optional(),
  certDir: z.string().trim().max(2048).optional(),
  renewBeforeDays: z.number().int().min(1).max(90).optional(),
  staging: z.boolean().optional(),
  ownerVerificationCode: z.string().trim().min(1).max(32).optional(),
});

function deriveSetupPublicUrl(
  request: FastifyRequest,
  serverPort: number,
  fallbackPublicUrl: string,
): string {
  return deriveRequestOrigin(request, {
    serverPort,
    fallbackPublicUrl,
  });
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
      if (!currentUser && (!isRequestFromHostMachine(request) || request.headers.origin)) {
        reply.code(401).send({
          error: {
            code: 'SETUP_AUTH_REQUIRED',
            message: 'First-run setup must be completed by a signed-in user.',
          },
        });
        return;
      }
      const config = app.appContext.serverConfig.get();
      let publicUrl: string;
      try {
        publicUrl = parsed.data.serverAddress
          ? normalizeHttpOrigin(parsed.data.serverAddress)
          : parsed.data.publicUrl
            ? normalizeHttpOrigin(parsed.data.publicUrl)
            : deriveSetupPublicUrl(request, config.server.port, config.server.publicUrl);
      } catch {
        reply.code(400).send({
          error: {
            code: 'SERVER_ADDRESS_INVALID',
            message: 'Server address must be a full http:// or https:// URL.',
          },
        });
        return;
      }

      const hostRequest = isRequestFromHostMachine(request);
      const ownerCode = parsed.data.ownerVerificationCode?.trim();
      let ownerCodeAccepted = false;
      if (ownerCode) {
        const verification = app.appContext.setup.verifyOwnerVerificationCode(ownerCode);
        if (!verification.ok) {
          reply.code(403).send({
            error: {
              code: verification.code,
              message: verification.message,
            },
          });
          return;
        }
        ownerCodeAccepted = true;
      }

      const basePayload = {
        ...parsed.data,
        publicUrl,
        serverAddress: publicUrl,
        ownerVerificationCode: undefined,
        adminDid: undefined,
        adminHandle: undefined,
        adminDisplayName: undefined,
        adminAvatarUrl: undefined,
      };
      const shouldAssignCurrentUser = currentUser && (hostRequest || ownerCodeAccepted);
      const payload = shouldAssignCurrentUser
        ? {
            ...basePayload,
            adminDid: currentUser.did,
            adminHandle: currentUser.handle,
            adminDisplayName: currentUser.displayName,
            adminAvatarUrl: currentUser.avatarUrl,
          }
        : {
            ...basePayload,
            adminDid: !currentUser && hostRequest ? parsed.data.adminDid : undefined,
            adminHandle: !currentUser && hostRequest ? parsed.data.adminHandle : undefined,
            adminDisplayName: !currentUser && hostRequest ? parsed.data.adminDisplayName : undefined,
            adminAvatarUrl: !currentUser && hostRequest ? parsed.data.adminAvatarUrl : undefined,
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

  app.post('/setup/owner/code', async (request, reply) => {
    if (!isRequestFromHostMachine(request)) {
      reply.code(403).send({
        error: {
          code: 'HOST_ONLY',
          message: 'Owner verification codes can only be generated from the server host.',
        },
      });
      return;
    }
    if (app.appContext.setup.getOwnerUserId()) {
      reply.code(409).send({
        error: {
          code: 'OWNER_ALREADY_ASSIGNED',
          message: 'This server already has an owner.',
        },
      });
      return;
    }

    const code = app.appContext.setup.createOwnerVerificationCode();
    request.log.info({ expiresAt: code.expiresAt }, 'Generated owner verification code');
    reply.send({
      ownerVerificationCode: code.code,
      expiresAt: code.expiresAt,
      verificationCodeLength: 8,
    });
  });

  app.post('/setup/owner/claim', async (request, reply) => {
    const parsed = OwnerClaimSchema.safeParse(request.body ?? {});
    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser || !parsed.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (request.serverRemoval) {
      reply.code(403).send({
        error: {
          code: 'SERVER_REMOVED',
          message: 'This account cannot claim ownership of this server.',
        },
      });
      return;
    }
    if (app.appContext.setup.getOwnerUserId()) {
      reply.code(409).send({
        error: {
          code: 'OWNER_ALREADY_ASSIGNED',
          message: 'This server already has an owner.',
        },
      });
      return;
    }

    const verification = app.appContext.setup.verifyOwnerVerificationCode(
      parsed.data.ownerVerificationCode,
    );
    if (!verification.ok) {
      reply.code(403).send({
        error: {
          code: verification.code,
          message: verification.message,
        },
      });
      return;
    }

    try {
      const owner = app.appContext.setup.transferOwnership({
        serverId: status.serverId,
        actorId: request.currentUser.id,
        targetUserId: request.currentUser.id,
      });
      reply.send({
        ownerUserId: owner.id,
      });
    } catch (error) {
      reply.code(400).send({
        error: error instanceof Error ? error.message : 'Ownership claim failed.',
      });
    }
  });

  app.get('/setup/https/acme/status', async () => app.appContext.acme.status());

  app.post('/setup/https/acme/issue', async (request, reply) => {
    const parsed = AcmeIssueSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }
    const ownerUserId = app.appContext.setup.getOwnerUserId();
    if (ownerUserId) {
      reply.code(409).send({
        error: {
          code: 'OWNER_ALREADY_ASSIGNED',
          message: 'Use Server Settings to manage HTTPS after ownership is assigned.',
        },
      });
      return;
    }
    if (!isRequestFromHostMachine(request)) {
      const verification = parsed.data.ownerVerificationCode
        ? app.appContext.setup.verifyOwnerVerificationCode(
            parsed.data.ownerVerificationCode,
            Date.now(),
            { consume: false },
          )
        : null;
      if (!verification?.ok) {
        reply.code(403).send({
          error: {
            code: verification?.code ?? 'OWNER_CODE_REQUIRED',
            message:
              verification?.message ??
              'Enter the owner verification code from the server terminal to set up HTTPS remotely.',
          },
        });
        return;
      }
    }

    try {
      const result = await app.appContext.acme.issueCertificate(parsed.data);
      reply.send(result);
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'ACME_ISSUE_FAILED',
          message: error instanceof Error ? error.message : 'Unable to issue HTTPS certificate.',
        },
      });
    }
  });
}
