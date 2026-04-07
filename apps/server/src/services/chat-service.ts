import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import type { Attachment, Channel, Message } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { MetricsService } from '../metrics/metrics-service.js';
import type { ModerationService } from './moderation-service.js';
import type { CurrentConfig } from '@current/config';
import { containsLink, evaluateAutomod, extractMentionCount } from '../moderation/automod.js';

export class ChatService {
  private readonly lastMessageByUserChannel = new Map<string, number>();

  constructor(
    private readonly repos: RepositoryBag,
    private readonly metrics: MetricsService,
    private readonly moderation: ModerationService,
    private readonly getConfig: () => CurrentConfig,
  ) {
    mkdirSync(this.getConfig().storage.uploadDir, { recursive: true });
  }

  listChannels(serverId: string): Channel[] {
    return this.repos.channels.list(serverId);
  }

  createChannel(input: {
    serverId: string;
    name: string;
    type: 'text' | 'voice' | 'dm';
    categoryId?: string;
    topic?: string;
    slowmodeSeconds?: number;
    actorId: string;
  }): Channel {
    const channel = this.repos.channels.create(input);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.create',
      targetType: 'channel',
      targetId: channel.id,
      payload: channel,
    });
    return channel;
  }

  updateChannel(input: {
    channelId: string;
    serverId: string;
    actorId: string;
    patch: Partial<Omit<Channel, 'id' | 'serverId'>>;
  }): Channel | null {
    const channel = this.repos.channels.update(input.channelId, input.patch);
    if (!channel) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.update',
      targetType: 'channel',
      targetId: channel.id,
      payload: input.patch as Record<string, unknown>,
    });

    return channel;
  }

  deleteChannel(input: { channelId: string; serverId: string; actorId: string }): void {
    this.repos.channels.delete(input.channelId);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: input.channelId,
      payload: {},
    });
  }

  listMessages(channelId: string, limit = 50): Message[] {
    return this.repos.messages.listByChannel(channelId, limit);
  }

  sendMessage(input: {
    serverId: string;
    channelId: string;
    authorId: string;
    content: string;
    parentMessageId?: string;
    gifUrl?: string;
    attachmentIds?: string[];
  }): { message?: Message; blocked?: string[] } {
    const channel = this.repos.channels.findById(input.channelId);
    if (!channel) {
      throw new Error('Channel not found.');
    }

    const blocked = this.moderation.isBlockedFromMessaging(input.serverId, input.authorId);
    if (blocked.blocked) {
      return { blocked: [blocked.reason ?? 'blocked'] };
    }

    if (channel.locked) {
      return { blocked: ['channel_locked'] };
    }

    const cooldownKey = `${input.authorId}:${input.channelId}`;
    const lastPost = this.lastMessageByUserChannel.get(cooldownKey) ?? 0;
    const requiredDelayMs = channel.slowmodeSeconds * 1000;

    if (requiredDelayMs > 0 && Date.now() - lastPost < requiredDelayMs) {
      return { blocked: ['slowmode'] };
    }

    const serverRules = this.repos.automod.list(input.serverId);
    const evaluation = evaluateAutomod(
      serverRules,
      {
        message: input.content,
        mentionCount: extractMentionCount(input.content),
        containsLink: containsLink(input.content),
        isMemberTrusted: false,
      },
      {
        maxMentionsPerMessage: this.getConfig().moderation.maxMentionsPerMessage,
        linkPolicy: this.getConfig().moderation.linkPolicy,
      },
    );

    if (evaluation.blocked) {
      return { blocked: evaluation.reasons };
    }

    const attachments: Attachment[] = [];
    for (const attachmentId of input.attachmentIds ?? []) {
      const attachment = this.repos.messages
        .recordUploadedAttachment({
          fileName: 'placeholder',
          mimeType: 'application/octet-stream',
          byteSize: 0,
          path: attachmentId,
        });
      attachments.push(attachment);
    }

    const message = this.repos.messages.create({
      channelId: input.channelId,
      authorId: input.authorId,
      content: input.content,
      parentMessageId: input.parentMessageId,
      gifUrl: input.gifUrl,
      attachments,
    });

    this.lastMessageByUserChannel.set(cooldownKey, Date.now());
    this.metrics.incrementMessagesCreated();

    return { message };
  }

  editMessage(input: { messageId: string; content: string }): Message | null {
    return this.repos.messages.edit(input.messageId, input.content);
  }

  deleteMessage(input: { messageId: string; serverId: string; actorId: string }): Message | null {
    const message = this.repos.messages.softDelete(input.messageId);
    if (!message) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'message.delete',
      targetType: 'message',
      targetId: message.id,
      payload: {
        channelId: message.channelId,
        authorId: message.authorId,
      },
    });

    return message;
  }

  addReaction(input: { messageId: string; userId: string; emoji: string }): void {
    this.repos.messages.addReaction(input);
  }

  saveAttachment(input: { fileName: string; mimeType?: string; bytes: Buffer }): Attachment {
    const config = this.getConfig();
    if (input.bytes.length > config.media.maxAttachmentBytes) {
      throw new Error('Attachment exceeds configured max size.');
    }

    const detectedMime = input.mimeType ?? lookupMime(input.fileName);
    const mimeType = typeof detectedMime === 'string' ? detectedMime : 'application/octet-stream';
    const allowed = config.media.allowedMimePrefixes.some((prefix) => mimeType.startsWith(prefix));

    if (!allowed) {
      throw new Error('Attachment MIME type is not allowed.');
    }

    const safeName = `${Date.now()}-${input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = join(config.storage.uploadDir, safeName);
    writeFileSync(filePath, input.bytes);

    return this.repos.messages.recordUploadedAttachment({
      fileName: input.fileName,
      mimeType,
      byteSize: input.bytes.length,
      path: filePath,
    });
  }

  getAttachment(attachmentId: string): Attachment | null {
    return this.repos.messages.findAttachmentById(attachmentId);
  }

  async searchGifs(query: string, limit = 20): Promise<unknown> {
    const key = this.getConfig().media.klipyApiKey;
    if (!key) {
      throw new Error('Klipy API key is not configured.');
    }

    const url = new URL('https://api.klipy.com/v2/search');
    url.searchParams.set('q', query);
    url.searchParams.set('key', key);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('media_filter', 'gif,tinygif,mp4');

    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Klipy API error: ${text}`);
    }

    return response.json();
  }
}
