import type { FastifyInstance } from 'fastify';
import { GatewayEvents } from '@current/protocol';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';

export async function registerVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/voice/state', { preHandler: [requireAuth] }, async () => {
    return app.appContext.voice.listState();
  });

  app.post('/voice/channels/:channelId/token', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    if (!params.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const token = app.appContext.voice.issueChannelToken({
      userId: request.currentUser.id,
      channelId: params.data.channelId,
    });

    reply.send(token);
  });

  app.post('/voice/channels/:channelId/join', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = z
      .object({ muted: z.boolean().optional(), deafened: z.boolean().optional(), pushToTalk: z.boolean().optional() })
      .safeParse(request.body ?? {});

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const state = app.appContext.voice.joinChannel({
      userId: request.currentUser.id,
      channelId: params.data.channelId,
      ...body.data,
    });

    app.appContext.gateway.broadcast(GatewayEvents.VOICE_STATE_UPDATE, {
      voiceState: state,
    });

    reply.send(state);
  });

  app.post('/voice/channels/:channelId/leave', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    app.appContext.voice.leaveChannel(request.currentUser.id);

    app.appContext.gateway.broadcast(GatewayEvents.VOICE_STATE_UPDATE, {
      voiceState: {
        userId: request.currentUser.id,
        channelId: null,
      },
    });

    reply.code(204).send();
  });

  app.patch('/voice/state', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = z
      .object({
        muted: z.boolean().optional(),
        deafened: z.boolean().optional(),
        pushToTalk: z.boolean().optional(),
        speaking: z.boolean().optional(),
      })
      .safeParse(request.body);

    if (!body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const state = app.appContext.voice.patchState({
      userId: request.currentUser.id,
      ...body.data,
    });

    if (!state) {
      reply.code(404).send({ error: 'Voice state not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.VOICE_STATE_UPDATE, {
      voiceState: state,
    });

    reply.send(state);
  });

  app.get('/voice/channels/:channelId/state', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    reply.send(app.appContext.voice.listChannelState(params.data.channelId));
  });

  app.get('/voice/diagnostics', { preHandler: [requireAuth] }, async () => {
    return app.appContext.voice.diagnostics();
  });
}
