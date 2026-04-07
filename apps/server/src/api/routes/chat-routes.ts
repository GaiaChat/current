import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayEvents } from '@current/protocol';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasServerPermission } from '../permission-guard.js';

const ChannelCreateSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['text', 'voice', 'dm']),
  categoryId: z.string().optional(),
  topic: z.string().optional(),
  slowmodeSeconds: z.number().int().min(0).optional(),
});

const ChannelPatchSchema = z.object({
  categoryId: z.string().optional(),
  name: z.string().optional(),
  type: z.enum(['text', 'voice', 'dm']).optional(),
  topic: z.string().optional(),
  slowmodeSeconds: z.number().int().min(0).optional(),
  locked: z.boolean().optional(),
});

const MessageCreateSchema = z.object({
  content: z.string().max(4000),
  parentMessageId: z.string().optional(),
  gifUrl: z.string().url().optional(),
  attachmentIds: z.array(z.string()).optional(),
});

const MessagePatchSchema = z.object({
  content: z.string().max(4000),
});

const ReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/channels', { preHandler: [requireAuth] }, async () => {
    const status = app.appContext.setup.status();
    if (!status.serverId) {
      return [];
    }

    return app.appContext.chat.listChannels(status.serverId);
  });

  app.post('/channels', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = ChannelCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(401).send({ error: { code: 'NO_SERVER', message: 'No configured server.' } });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    const channel = app.appContext.chat.createChannel({
      ...parsed.data,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_create',
      channel,
    });

    reply.code(201).send(channel);
  });

  app.patch('/channels/:channelId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const patch = ChannelPatchSchema.safeParse(request.body);

    if (!params.success || !patch.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    const channel = app.appContext.chat.updateChannel({
      channelId: params.data.channelId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
      patch: patch.data,
    });

    if (!channel) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_update',
      channel,
    });

    reply.send(channel);
  });

  app.delete('/channels/:channelId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    if (!params.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    app.appContext.chat.deleteChannel({
      channelId: params.data.channelId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_delete',
      channelId: params.data.channelId,
    });

    reply.code(204).send();
  });

  app.get('/channels/:channelId/messages', { preHandler: [requireAuth] }, async (request) => {
    const params = z.object({ channelId: z.string() }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);

    return app.appContext.chat.listMessages(params.channelId, query.limit ?? 50);
  });

  app.post('/channels/:channelId/messages', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = MessageCreateSchema.safeParse(request.body);

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const result = app.appContext.chat.sendMessage({
      serverId: status.serverId,
      channelId: params.data.channelId,
      authorId: request.currentUser.id,
      content: body.data.content,
      parentMessageId: body.data.parentMessageId,
      gifUrl: body.data.gifUrl,
      attachmentIds: body.data.attachmentIds,
    });

    if (!result.message) {
      reply.code(409).send({
        error: {
          code: 'MESSAGE_BLOCKED',
          reasons: result.blocked,
        },
      });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_CREATE, {
      message: result.message,
    });

    reply.code(201).send(result.message);
  });

  app.patch('/messages/:messageId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    const body = MessagePatchSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const message = app.appContext.chat.editMessage({
      messageId: params.data.messageId,
      content: body.data.content,
    });

    if (!message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_UPDATE, {
      message,
    });

    reply.send(message);
  });

  app.delete('/messages/:messageId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    if (!params.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const message = app.appContext.chat.deleteMessage({
      messageId: params.data.messageId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });
    if (!message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_DELETE, {
      messageId: message.id,
      channelId: message.channelId,
    });

    reply.code(204).send();
  });

  app.post('/messages/:messageId/reactions', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    const body = ReactionSchema.safeParse(request.body);

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    app.appContext.chat.addReaction({
      messageId: params.data.messageId,
      userId: request.currentUser.id,
      emoji: body.data.emoji,
    });

    reply.code(204).send();
  });

  app.post('/media/attachments', { preHandler: [requireAuth] }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      reply.code(400).send({ error: 'No file uploaded.' });
      return;
    }

    const bytes = await file.toBuffer();
    try {
      const attachment = app.appContext.chat.saveAttachment({
        fileName: file.filename,
        mimeType: file.mimetype,
        bytes,
      });
      reply.code(201).send(attachment);
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'ATTACHMENT_REJECTED',
          message: error instanceof Error ? error.message : 'Attachment upload failed.',
        },
      });
    }
  });

  app.get('/media/attachments/:attachmentId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ attachmentId: z.string() }).safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const attachment = app.appContext.chat.getAttachment(params.data.attachmentId);
    if (!attachment) {
      reply.code(404).send({ error: 'Attachment not found.' });
      return;
    }

    reply.type(attachment.mimeType);
    return reply.send(createReadStream(attachment.path));
  });

  app.get('/media/gifs/search', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = z
      .object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).optional() })
      .safeParse(request.query);

    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    try {
      const data = await app.appContext.chat.searchGifs(query.data.q, query.data.limit ?? 20);
      reply.send(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GIF search failed.';
      reply.send({
        results: [],
        provider: 'klipy',
        providerError: {
          code: 'KLIPY_ERROR',
          message,
        },
      });
    }
  });
}
