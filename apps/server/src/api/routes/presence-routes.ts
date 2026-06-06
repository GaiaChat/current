import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';
import { nowIso } from '../../utils/time.js';

const AUDIO_ACTIVITY_TTL_MS = 90_000;
const AUDIO_ACTIVITY_MAX_TTL_MS = 5 * 60_000;

const PresencePatchSchema = z.object({
  status: z.enum(['online', 'away', 'dnd', 'invisible']),
});

const AudioActivitySchema = z.object({
  provider: z.literal('spotify'),
  title: z.string().trim().min(1).max(160),
  artists: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
  album: z.string().trim().min(1).max(160).optional(),
  albumArtUrl: z.string().trim().url().max(2048).optional(),
  trackUrl: z.string().trim().url().max(2048).optional(),
  isPlaying: z.boolean(),
  progressMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

const AudioActivityPatchSchema = z.object({
  activity: AudioActivitySchema.nullable(),
});

function boundedAudioActivityExpiresAt(value: string | undefined): string {
  const now = Date.now();
  const fallback = now + AUDIO_ACTIVITY_TTL_MS;
  const parsed = value ? Date.parse(value) : fallback;
  const expiresAt = Number.isFinite(parsed) ? parsed : fallback;
  return new Date(Math.max(now, Math.min(expiresAt, now + AUDIO_ACTIVITY_MAX_TTL_MS))).toISOString();
}

export async function registerPresenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/presence', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    reply.send({
      items: app.appContext.gateway.listPresenceForViewer(request.currentUser.id),
      selfStatus: app.appContext.gateway.getSelectedPresenceStatus(request.currentUser.id),
    });
  });

  app.patch('/presence', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = PresencePatchSchema.safeParse(request.body);
    if (!body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const presence = app.appContext.gateway.setSelectedPresenceStatus(request.currentUser.id, body.data.status);

    reply.send({
      presence,
      selfStatus: body.data.status,
    });
  });

  app.patch('/presence/audio', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = AudioActivityPatchSchema.safeParse(request.body);
    if (!body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!body.data.activity) {
      const presence = app.appContext.gateway.setAudioActivity(request.currentUser.id, null);
      reply.send({ presence });
      return;
    }

    const updatedAt = body.data.activity.updatedAt ?? nowIso();
    const presence = app.appContext.gateway.setAudioActivity(request.currentUser.id, {
      ...body.data.activity,
      updatedAt,
      expiresAt: boundedAudioActivityExpiresAt(body.data.activity.expiresAt),
    });

    reply.send({ presence });
  });
}
