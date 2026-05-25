import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GatewayEvents } from '@current/protocol';
import type { Channel, CurrentUser, Message } from '@current/types';
import type {
  CurrentMessageNotificationPayload,
  CurrentNotificationKind,
} from '../../db/repositories/notification-events-repository.js';
import {
  effectiveChannelNotificationLevel,
  isChannelMuteActive,
  type ChannelNotificationLevel,
  type ChannelNotificationSetting,
} from '../../db/repositories/channel-notification-settings-repository.js';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasChannelPermission, hasServerPermission } from '../permission-guard.js';
import { decodeCursor } from '../../utils/cursor.js';
import { nowIso } from '../../utils/time.js';

const ChannelTypeSchema = z.enum(['category', 'text', 'voice', 'dm']);
const ChannelPositionSchema = z.number().int().min(0).max(1_000_000_000);
type MultipartUploadFile = NonNullable<Awaited<ReturnType<FastifyRequest['file']>>>;

const ChannelCreateSchema = z.object({
  name: z.string().min(1),
  type: ChannelTypeSchema,
  categoryId: z.string().nullable().optional(),
  topic: z.string().optional(),
  slowmodeSeconds: z.number().int().min(0).optional(),
  position: ChannelPositionSchema.optional(),
});

const ChannelPatchSchema = z.object({
  categoryId: z.string().nullable().optional(),
  name: z.string().optional(),
  type: ChannelTypeSchema.optional(),
  topic: z.string().optional(),
  slowmodeSeconds: z.number().int().min(0).optional(),
  locked: z.boolean().optional(),
  position: ChannelPositionSchema.optional(),
});

const ChannelOrderSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    categoryId: z.string().nullable().optional(),
    position: ChannelPositionSchema,
  })).min(1).max(500),
});

const ChannelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().trim().min(1).max(1024).optional(),
});

const ChannelsAfterCursorSchema = z.object({
  position: z.number().optional(),
  createdAt: z.string().min(1),
  id: z.string().min(1),
});

const EncryptedMessageContentSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-GCM'),
  keyId: z.string().trim().min(8).max(128),
  nonce: z.string().trim().min(16).max(64),
  ciphertext: z.string().trim().min(1).max(32768),
});

const MessageCreateSchema = z
  .object({
    content: z.string().max(4000).optional().default(''),
    encryptedContent: EncryptedMessageContentSchema.optional(),
    parentMessageId: z.string().optional(),
    notificationMentions: z.array(z.string().trim().min(1).max(253)).max(32).optional(),
    gifUrl: z.string().url().optional(),
    attachmentIds: z.array(z.string().trim().min(1).max(128)).max(10).optional(),
  })
  .superRefine((value, context) => {
    if (value.encryptedContent && value.content.trim().length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Encrypted messages must not include plaintext content.',
      });
    }
  });

function normalizeNotificationMentionHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : null;
}

function normalizeNotificationMentionHandles(handles: string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const handle of handles ?? []) {
    const value = normalizeNotificationMentionHandle(handle);
    if (value) {
      normalized.add(value);
    }
  }
  return [...normalized];
}

function toUploadBufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error('Unsupported upload stream chunk.');
}

async function readAttachmentUploadBytes(file: MultipartUploadFile, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of file.file) {
    const buffer = toUploadBufferChunk(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      file.file.destroy();
      throw new Error('Attachment exceeds configured max size.');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, totalBytes);
}

function extractNotificationMentionHandles(content: string): string[] {
  const handles = new Set<string>();
  for (const match of content.matchAll(/@[A-Za-z0-9._-]+/g)) {
    const handle = normalizeNotificationMentionHandle(match[0]);
    if (handle) {
      handles.add(handle);
    }
  }
  return [...handles];
}

const MessagePatchSchema = z
  .object({
    content: z.string().max(4000).optional().default(''),
    encryptedContent: EncryptedMessageContentSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.encryptedContent && value.content.trim().length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Encrypted messages must not include plaintext content.',
      });
    }
  });

const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().trim().min(1).max(1024).optional(),
});

const CurrentNotificationsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const IsoTimestampSchema = z.string().trim().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value)), {
  message: 'Expected an ISO timestamp.',
});

const ChannelNotificationLevelSchema = z.enum(['default', 'all', 'mentions', 'nothing']);

const ChannelNotificationSettingsPatchSchema = z.object({
  notificationLevel: ChannelNotificationLevelSchema.optional(),
  mutedUntil: IsoTimestampSchema.nullable().optional(),
});

const ChannelReadSchema = z.object({
  readAt: IsoTimestampSchema.optional(),
});

const MessageSearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  from: z.string().trim().min(1).max(128).optional(),
});

const ServerMessageSearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  from: z.string().trim().min(1).max(128).optional(),
  channelId: z.string().trim().min(1).max(128).optional(),
});

const MessagesBeforeCursorSchema = z.object({
  createdAt: z.string().min(1),
  id: z.string().min(1),
});

const TypingUpdateSchema = z.object({
  isTyping: z.boolean().optional(),
});

const ReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

const AttachmentUploadQuerySchema = z.object({
  channelId: z.string().trim().min(1).max(128).optional(),
});

function isConfiguredServerAsset(app: FastifyInstance, attachmentId: string): boolean {
  const server = app.appContext.repos.servers.getPrimaryServer();
  const config = app.appContext.serverConfig.get();
  return (
    server?.iconAttachmentId === attachmentId ||
    server?.bannerAttachmentId === attachmentId ||
    config.appearance.backgroundAttachmentId === attachmentId
  );
}

function canViewChannel(app: FastifyInstance, input: { serverId: string; channelId: string; user: CurrentUser }): boolean {
  return hasChannelPermission(app.appContext, {
    serverId: input.serverId,
    channelId: input.channelId,
    user: input.user,
    permission: 'VIEW_CHANNEL',
  });
}

function filterVisibleChannels(
  app: FastifyInstance,
  input: { serverId: string; user: CurrentUser; channels: Channel[] },
): Channel[] {
  return input.channels.filter((channel) =>
    canViewChannel(app, {
      serverId: input.serverId,
      channelId: channel.id,
      user: input.user,
    }),
  );
}

function visibleMessageChannelIds(app: FastifyInstance, input: { serverId: string; user: CurrentUser }): string[] {
  return filterVisibleChannels(app, {
    serverId: input.serverId,
    user: input.user,
    channels: app.appContext.repos.channels.listAll(input.serverId),
  })
    .filter((channel) => channel.type === 'text' || channel.type === 'dm')
    .map((channel) => channel.id);
}

async function applyMessageBlocksForViewer(
  app: FastifyInstance,
  viewer: CurrentUser,
  message: Message,
): Promise<Message> {
  return app.appContext.atprotoBlocks.applyMessageBlocksForViewer(viewer, message);
}

async function applyMessagesBlocksForViewer(
  app: FastifyInstance,
  viewer: CurrentUser,
  messages: Message[],
): Promise<Message[]> {
  return app.appContext.atprotoBlocks.applyMessagesBlocksForViewer(viewer, messages);
}

async function isMessageHiddenByAtprotoBlock(
  app: FastifyInstance,
  viewer: CurrentUser,
  message: Message,
): Promise<boolean> {
  return app.appContext.atprotoBlocks.shouldHideMessageForViewer(viewer, message);
}

function notificationKindForTarget(input: {
  mentioned: boolean;
  replyToUser: boolean;
}): CurrentNotificationKind {
  if (input.mentioned) {
    return 'current_mention';
  }
  if (input.replyToUser) {
    return 'current_reply';
  }
  return 'current_message';
}

function serializeChannelNotificationSetting(setting: ChannelNotificationSetting): ChannelNotificationSetting {
  return {
    userId: setting.userId,
    channelId: setting.channelId,
    notificationLevel: setting.notificationLevel,
    mutedUntil: setting.mutedUntil,
    lastReadAt: setting.lastReadAt,
    updatedAt: setting.updatedAt,
  };
}

function isNotificationRead(input: { setting: ChannelNotificationSetting; createdAt: string }): boolean {
  if (!input.setting.lastReadAt) {
    return false;
  }
  const notificationCreatedAt = Date.parse(input.createdAt);
  const lastReadAt = Date.parse(input.setting.lastReadAt);
  return Number.isFinite(notificationCreatedAt) && Number.isFinite(lastReadAt) && notificationCreatedAt <= lastReadAt;
}

function shouldDeliverNotification(input: {
  kind: CurrentNotificationKind;
  setting: ChannelNotificationSetting;
  createdAt?: string;
  now?: number;
}): boolean {
  if (input.createdAt && isNotificationRead({ setting: input.setting, createdAt: input.createdAt })) {
    return false;
  }
  if (isChannelMuteActive(input.setting.mutedUntil, input.now)) {
    return false;
  }
  const level = effectiveChannelNotificationLevel(input.setting.notificationLevel);
  if (level === 'nothing') {
    return false;
  }
  if (level === 'mentions') {
    return input.kind === 'current_mention' || input.kind === 'current_reply';
  }
  return true;
}

async function recordCurrentNotificationEvents(
  app: FastifyInstance,
  input: {
    serverId: string;
    channelId: string;
    gatewaySeq: number;
    message: Message;
    mentionHandles: string[];
    replyToUserId?: string;
  },
): Promise<void> {
  const targetedUsers = new Map<
    string,
    {
      user: CurrentUser;
      mentioned: boolean;
      replyToUser: boolean;
      mentionHandles: Set<string>;
    }
  >();

  const markTarget = (user: CurrentUser | null, patch: { mentionHandle?: string; replyToUser?: boolean }) => {
    if (!user || user.id === input.message.authorId) {
      return;
    }

    const existing = targetedUsers.get(user.id) ?? {
      user,
      mentioned: false,
      replyToUser: false,
      mentionHandles: new Set<string>(),
    };

    if (patch.mentionHandle) {
      existing.mentioned = true;
      existing.mentionHandles.add(patch.mentionHandle);
    }
    if (patch.replyToUser) {
      existing.replyToUser = true;
    }
    targetedUsers.set(user.id, existing);
  };

  if (input.replyToUserId) {
    markTarget(app.appContext.repos.users.findById(input.replyToUserId), { replyToUser: true });
  }

  for (const handle of input.mentionHandles) {
    markTarget(app.appContext.repos.users.findByHandle(handle), { mentionHandle: handle });
  }

  const settingsByUserId = new Map(
    app.appContext.repos.channelNotificationSettings
      .listForChannel(input.channelId)
      .map((setting) => [setting.userId, setting]),
  );

  const usersWithChannelAccess = app.appContext.repos.users.list().filter((user) => {
    if (user.id === input.message.authorId) {
      return false;
    }
    if (!canViewChannel(app, {
      serverId: input.serverId,
      channelId: input.channelId,
      user,
    })) {
      return false;
    }
    return true;
  });
  await app.appContext.atprotoBlocks.prefetchMessageForViewers(input.message, usersWithChannelAccess);

  for (const user of usersWithChannelAccess) {
    if (await isMessageHiddenByAtprotoBlock(app, user, input.message)) {
      continue;
    }

    const target = targetedUsers.get(user.id);
    const kind = notificationKindForTarget({
      mentioned: Boolean(target?.mentioned),
      replyToUser: Boolean(target?.replyToUser),
    });
    const setting =
      settingsByUserId.get(user.id) ??
      app.appContext.repos.channelNotificationSettings.defaultFor(user.id, input.channelId);
    if (!shouldDeliverNotification({ kind, setting })) {
      continue;
    }

    const notification: CurrentMessageNotificationPayload = {
      ...(target && target.mentionHandles.size > 0 ? { mentionHandles: [...target.mentionHandles] } : {}),
      ...(target?.replyToUser ? { replyToUserId: user.id } : {}),
    };

    app.appContext.repos.notificationEvents.append({
      gatewaySeq: input.gatewaySeq,
      userId: user.id,
      serverId: input.serverId,
      channelId: input.channelId,
      messageId: input.message.id,
      kind,
      payload: {
        message: input.message,
        ...(Object.keys(notification).length > 0 ? { notification } : {}),
      },
    });
  }
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/channels', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = ChannelsQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const after = query.data.after
      ? ChannelsAfterCursorSchema.safeParse(decodeCursor<unknown>(query.data.after))
      : null;
    if (query.data.after && (!after || !after.success)) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CURSOR',
          message: 'Invalid pagination cursor.',
        },
      });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      return {
        items: [],
        pageInfo: {
          hasMore: false,
        },
      };
    }

    const currentUser = request.currentUser;
    const serverId = status.serverId;
    if (!currentUser || !serverId) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    const page = app.appContext.chat.listChannelsPage({
      serverId,
      limit: query.data.limit ?? 75,
      after: after?.success ? after.data : undefined,
    });
    return {
      ...page,
      items: filterVisibleChannels(app, {
        serverId,
        user: currentUser,
        channels: page.items,
      }),
    };
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

    let channel;
    try {
      channel = app.appContext.chat.createChannel({
        ...parsed.data,
        serverId: status.serverId,
        actorId: request.currentUser.id,
      });
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CHANNEL',
          message: error instanceof Error ? error.message : 'Invalid channel.',
        },
      });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_create',
      channel,
    });

    reply.code(201).send(channel);
  });

  app.put('/channels/order', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = ChannelOrderSchema.safeParse(request.body);
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

    let channels;
    try {
      channels = app.appContext.chat.reorderChannels({
        serverId: status.serverId,
        actorId: request.currentUser.id,
        items: parsed.data.items,
      });
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CHANNEL_ORDER',
          message: error instanceof Error ? error.message : 'Invalid channel order.',
        },
      });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_reorder',
      channels,
    });

    reply.send({ items: channels });
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

    let channel;
    try {
      channel = app.appContext.chat.updateChannel({
        channelId: params.data.channelId,
        serverId: status.serverId,
        actorId: request.currentUser.id,
        patch: patch.data,
      });
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CHANNEL',
          message: error instanceof Error ? error.message : 'Invalid channel.',
        },
      });
      return;
    }

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

    const deleted = app.appContext.chat.deleteChannel({
      channelId: params.data.channelId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });
    if (!deleted) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_delete',
      channelId: params.data.channelId,
    });

    reply.code(204).send();
  });

  app.get('/notification-settings/channels', { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header('cache-control', 'no-store');

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      return { items: [] };
    }

    const currentUser = request.currentUser;
    if (!currentUser) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    const storedByChannelId = new Map(
      app.appContext.repos.channelNotificationSettings
        .listForUser(currentUser.id)
        .map((setting) => [setting.channelId, setting]),
    );
    const channels = filterVisibleChannels(app, {
      serverId: status.serverId,
      user: currentUser,
      channels: app.appContext.repos.channels.listAll(status.serverId),
    }).filter((channel) => channel.type !== 'category');

    return {
      items: channels.map((channel) =>
        serializeChannelNotificationSetting(
          storedByChannelId.get(channel.id) ??
            app.appContext.repos.channelNotificationSettings.defaultFor(currentUser.id, channel.id),
        ),
      ),
    };
  });

  app.put('/channels/:channelId/notification-settings', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = ChannelNotificationSettingsPatchSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: !body.success ? body.error.flatten() : 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId || channel.type === 'category') {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    const setting = app.appContext.repos.channelNotificationSettings.update({
      userId: request.currentUser.id,
      channelId: channel.id,
      notificationLevel: body.data.notificationLevel as ChannelNotificationLevel | undefined,
      mutedUntil: body.data.mutedUntil,
    });
    const serialized = serializeChannelNotificationSetting(setting);
    app.appContext.gateway.broadcast(GatewayEvents.NOTIFICATION_UPDATE, {
      action: 'channel_notification_settings',
      userId: request.currentUser.id,
      channelId: channel.id,
      settings: serialized,
    });

    reply.send(serialized);
  });

  app.put('/channels/:channelId/read', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = ChannelReadSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: !body.success ? body.error.flatten() : 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId || channel.type === 'category') {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    const readAt = body.data.readAt ?? nowIso();
    const setting = app.appContext.repos.channelNotificationSettings.update({
      userId: request.currentUser.id,
      channelId: channel.id,
      lastReadAt: readAt,
    });
    const serialized = serializeChannelNotificationSetting(setting);
    app.appContext.gateway.broadcast(GatewayEvents.NOTIFICATION_UPDATE, {
      action: 'channel_read',
      userId: request.currentUser.id,
      channelId: channel.id,
      readAt,
      settings: serialized,
    });

    reply.send(serialized);
  });

  app.get('/notifications/current', { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header('cache-control', 'no-store');

    const query = CurrentNotificationsQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      return {
        items: [],
        pageInfo: {
          hasMore: false,
          latestSeq: 0,
        },
      };
    }

    const currentUser = request.currentUser;
    const serverId = status.serverId;
    if (!currentUser || !serverId) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    const afterSeq = query.data.afterSeq ?? 0;
    const limit = query.data.limit ?? 100;
    const latestSeq = app.appContext.repos.gatewayEvents.latestSeq();
    const rows = app.appContext.repos.notificationEvents.listForUserSince({
      userId: currentUser.id,
      afterSeq,
      limit: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    const settingsByChannelId = new Map(
      app.appContext.repos.channelNotificationSettings
        .listForUser(currentUser.id)
        .map((setting) => [setting.channelId, setting]),
    );
    const visibleRows = pageRows.filter((row) => {
      const setting =
        settingsByChannelId.get(row.channelId) ??
        app.appContext.repos.channelNotificationSettings.defaultFor(currentUser.id, row.channelId);
      return (
        row.serverId === serverId &&
        canViewChannel(app, {
          serverId,
          channelId: row.channelId,
          user: currentUser,
        }) &&
        shouldDeliverNotification({
          kind: row.kind,
          setting,
          createdAt: row.createdAt,
        })
      );
    });
    const hasMore = rows.length > limit;
    const lastScannedSeq = pageRows[pageRows.length - 1]?.seq ?? afterSeq;

    const items = await Promise.all(visibleRows.map(async (row) => ({
      id: row.eventId,
      seq: row.seq,
      kind: row.kind,
      message: await applyMessageBlocksForViewer(app, currentUser, row.payload.message),
      notification: row.payload.notification,
      createdAt: row.createdAt,
    })));
    return {
      items,
      pageInfo: {
        hasMore,
        nextAfterSeq: hasMore ? lastScannedSeq : undefined,
        latestSeq: Math.max(latestSeq, lastScannedSeq),
      },
    };
  });

  app.get('/channels/:channelId/messages', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).parse(request.params);
    const query = MessagesQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const before = query.data.before
      ? MessagesBeforeCursorSchema.safeParse(decodeCursor<unknown>(query.data.before))
      : null;
    if (query.data.before && (!before || !before.success)) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CURSOR',
          message: 'Invalid pagination cursor.',
        },
      });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!request.currentUser || !canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const page = app.appContext.chat.listMessagesPage({
      channelId: params.channelId,
      limit: query.data.limit ?? 40,
      before: before?.success ? before.data : undefined,
      identityMode,
    });
    return {
      ...page,
      items: await applyMessagesBlocksForViewer(app, request.currentUser, page.items),
    };
  });

  app.get('/channels/:channelId/messages/search', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const query = MessageSearchQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!request.currentUser || !canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const items = app.appContext.chat.searchMessages({
      channelId: params.data.channelId,
      query: query.data.q,
      limit: query.data.limit ?? 10,
      authorId: query.data.from,
      identityMode,
    });
    return {
      items: await applyMessagesBlocksForViewer(app, request.currentUser, items),
    };
  });

  app.get('/messages/search', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = ServerMessageSearchQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      return { items: [] };
    }
    if (!request.currentUser) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    if (query.data.channelId) {
      const channel = app.appContext.chat.getChannelById(query.data.channelId);
      if (!channel || channel.serverId !== status.serverId) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }
      if (!canViewChannel(app, {
        serverId: status.serverId,
        channelId: channel.id,
        user: request.currentUser,
      })) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const channelIds = query.data.channelId
      ? [query.data.channelId]
      : visibleMessageChannelIds(app, {
          serverId: status.serverId,
          user: request.currentUser,
        });
    const items = app.appContext.chat.searchMessagesInServer({
      serverId: status.serverId,
      query: query.data.q,
      limit: query.data.limit ?? 10,
      authorId: query.data.from,
      channelId: query.data.channelId,
      channelIds,
      identityMode,
    });
    return {
      items: await applyMessagesBlocksForViewer(app, request.currentUser, items),
    };
  });

  app.get('/messages/:messageId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const message = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
      identityMode,
    });

    if (!message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!request.currentUser || !canViewChannel(app, {
      serverId: status.serverId,
      channelId: message.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    reply.send(await applyMessageBlocksForViewer(app, request.currentUser, message));
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

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    if (!hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'SEND_MESSAGES',
    })) {
      denyForbidden(reply, 'SEND_MESSAGES');
      return;
    }

    if ((body.data.attachmentIds?.length ?? 0) > 0 && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'ATTACH_FILES',
    })) {
      denyForbidden(reply, 'ATTACH_FILES');
      return;
    }

    if (body.data.gifUrl && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'USE_GIFS',
    })) {
      denyForbidden(reply, 'USE_GIFS');
      return;
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const requestedParentMessage = body.data.parentMessageId
      ? app.appContext.chat.getMessageById({
          messageId: body.data.parentMessageId,
          serverId: status.serverId,
          identityMode,
        })
      : null;
    if (
      requestedParentMessage &&
      (await isMessageHiddenByAtprotoBlock(app, request.currentUser, requestedParentMessage))
    ) {
      reply.code(409).send({
        error: {
          code: 'MESSAGE_BLOCKED',
          reasons: ['atproto_blocked_reply_parent'],
        },
      });
      return;
    }

    const result = app.appContext.chat.sendMessage({
      serverId: status.serverId,
      channelId: params.data.channelId,
      authorId: request.currentUser.id,
      content: body.data.content,
      encryptedContent: body.data.encryptedContent,
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

    const mentionHandles = normalizeNotificationMentionHandles([
      ...extractNotificationMentionHandles(body.data.content),
      ...(body.data.notificationMentions ?? []),
    ]);
    const parentMessage = result.message.parentMessageId
      ? requestedParentMessage ??
        app.appContext.chat.getMessageById({
          messageId: result.message.parentMessageId,
          serverId: status.serverId,
          identityMode,
        })
      : null;
    const notification =
      mentionHandles.length > 0 || parentMessage?.authorId
        ? {
            ...(mentionHandles.length > 0 ? { mentionHandles } : {}),
            ...(parentMessage?.authorId ? { replyToUserId: parentMessage.authorId } : {}),
          }
        : undefined;

    const gatewaySeq = app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_CREATE, {
      message: result.message,
      ...(notification ? { notification } : {}),
    });
    await recordCurrentNotificationEvents(app, {
      serverId: status.serverId,
      channelId: channel.id,
      gatewaySeq,
      message: result.message,
      mentionHandles,
      replyToUserId: parentMessage?.authorId,
    });

    reply.code(201).send(result.message);
  });

  app.post('/channels/:channelId/typing', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = TypingUpdateSchema.safeParse(request.body ?? {});

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    if (channel.type !== 'text' && channel.type !== 'dm') {
      reply.code(409).send({
        error: {
          code: 'TYPING_UNSUPPORTED',
          message: 'Typing indicators are only available in text channels and DMs.',
        },
      });
      return;
    }

    if (!status.serverId || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    if (!hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'SEND_MESSAGES',
    })) {
      denyForbidden(reply, 'SEND_MESSAGES');
      return;
    }

    app.appContext.gateway.broadcastTypingUpdate({
      channelId: channel.id,
      userId: request.currentUser.id,
      isTyping: body.data.isTyping ?? true,
    });

    reply.code(204).send();
  });

  app.patch('/messages/:messageId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    const body = MessagePatchSchema.safeParse(request.body);

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const existing = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
    });
    if (!existing) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    if (existing.authorId !== request.currentUser.id && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
      permission: 'MANAGE_MESSAGES',
    })) {
      denyForbidden(reply, 'MANAGE_MESSAGES');
      return;
    }

    const message = app.appContext.chat.editMessage({
      messageId: params.data.messageId,
      content: body.data.content,
      encryptedContent: body.data.encryptedContent,
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

    const existing = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
    });
    if (!existing) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    if (existing.authorId !== request.currentUser.id && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
      permission: 'MANAGE_MESSAGES',
    })) {
      denyForbidden(reply, 'MANAGE_MESSAGES');
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

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const existing = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
    });
    if (!existing) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (await isMessageHiddenByAtprotoBlock(app, request.currentUser, existing)) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    if (!hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
      permission: 'SEND_MESSAGES',
    })) {
      denyForbidden(reply, 'SEND_MESSAGES');
      return;
    }

    const result = app.appContext.chat.toggleReaction({
      messageId: params.data.messageId,
      userId: request.currentUser.id,
      emoji: body.data.emoji,
    });

    if (!result.message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_UPDATE, {
      message: result.message,
    });

    reply.send(result.message);
  });

  app.post('/media/attachments', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = AttachmentUploadQuerySchema.safeParse(request.query);
    if (!status.serverId || !request.currentUser || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (query.data.channelId) {
      const channel = app.appContext.chat.getChannelById(query.data.channelId);
      if (!channel || channel.serverId !== status.serverId) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }

      if (!canViewChannel(app, {
        serverId: status.serverId,
        channelId: channel.id,
        user: request.currentUser,
      })) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }

      if (!hasChannelPermission(app.appContext, {
        serverId: status.serverId,
        channelId: channel.id,
        user: request.currentUser,
        permission: 'ATTACH_FILES',
      })) {
        denyForbidden(reply, 'ATTACH_FILES');
        return;
      }
    } else if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'ATTACH_FILES',
    })) {
      denyForbidden(reply, 'ATTACH_FILES');
      return;
    }

    let file: MultipartUploadFile | undefined;
    try {
      file = await request.file();
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'ATTACHMENT_REJECTED',
          message: error instanceof Error ? error.message : 'Attachment upload failed.',
        },
      });
      return;
    }

    if (!file) {
      reply.code(400).send({ error: 'No file uploaded.' });
      return;
    }

    try {
      const maxAttachmentBytes = app.appContext.serverConfig.get().media.maxAttachmentBytes;
      const bytes = await readAttachmentUploadBytes(file, maxAttachmentBytes);
      const attachment = app.appContext.chat.saveAttachment({
        fileName: file.filename,
        mimeType: file.mimetype,
        bytes,
        ownerUserId: request.currentUser.id,
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

    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (attachment.messageId) {
      const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
      const message = app.appContext.chat.getMessageById({
        messageId: attachment.messageId,
        serverId: status.serverId,
        identityMode,
      });
      if (!message) {
        reply.code(404).send({ error: 'Attachment not found.' });
        return;
      }
      if (!canViewChannel(app, {
        serverId: status.serverId,
        channelId: message.channelId,
        user: request.currentUser,
      })) {
        reply.code(404).send({ error: 'Attachment not found.' });
        return;
      }
      if (await isMessageHiddenByAtprotoBlock(app, request.currentUser, message)) {
        reply.code(404).send({ error: 'Attachment not found.' });
        return;
      }
    } else if (
      attachment.ownerUserId !== request.currentUser.id &&
      !isConfiguredServerAsset(app, attachment.id) &&
      !hasServerPermission(app.appContext, {
        serverId: status.serverId,
        user: request.currentUser,
        permission: 'MANAGE_SERVER',
      })
    ) {
      reply.code(404).send({ error: 'Attachment not found.' });
      return;
    }

    reply
      .type(attachment.mimeType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'; object-src 'none'")
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Content-Disposition', `inline; filename="${attachment.fileName.replace(/["\\\r\n]/g, '_')}"`);
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
      const provider = app.appContext.serverConfig.get().media.gifProvider;
      reply.send({
        results: [],
        provider,
        providerError: {
          provider,
          code: `${provider.toUpperCase()}_ERROR`,
          message,
        },
      });
    }
  });
}
