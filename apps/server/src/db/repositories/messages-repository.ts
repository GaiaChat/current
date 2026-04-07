import type { Attachment, Message } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  parent_message_id: string | null;
  gif_url: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

interface AttachmentRow {
  id: string;
  message_id?: string | null;
  file_name: string;
  mime_type: string;
  byte_size: number;
  path: string;
}

export class MessagesRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  listByChannel(channelId: string, limit = 50): Message[] {
    const rows = this.db
      .prepare(
        `
      SELECT *
      FROM messages
      WHERE channel_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(channelId, limit) as unknown as MessageRow[];

    return rows.reverse().map((row) => this.toMessage(row));
  }

  create(input: {
    channelId: string;
    authorId: string;
    content: string;
    parentMessageId?: string;
    gifUrl?: string;
    attachments?: Attachment[];
  }): Message {
    const messageId = id('msg');
    const createdAt = nowIso();

    this.db
      .prepare(
        `
      INSERT INTO messages (id, channel_id, author_id, content, parent_message_id, gif_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        messageId,
        input.channelId,
        input.authorId,
        input.content,
        input.parentMessageId ?? null,
        input.gifUrl ?? null,
        createdAt,
      );

    for (const attachment of input.attachments ?? []) {
      this.attachToMessage(attachment, messageId);
    }

    return this.findById(messageId)!;
  }

  findById(messageId: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      | MessageRow
      | undefined;
    return row ? this.toMessage(row) : null;
  }

  edit(messageId: string, content: string): Message | null {
    this.db
      .prepare(
        `
      UPDATE messages
      SET content = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `,
      )
      .run(content, nowIso(), messageId);

    return this.findById(messageId);
  }

  softDelete(messageId: string): Message | null {
    this.db
      .prepare(
        `
      UPDATE messages
      SET deleted_at = ?
      WHERE id = ?
    `,
      )
      .run(nowIso(), messageId);

    return this.findById(messageId);
  }

  addReaction(input: { messageId: string; userId: string; emoji: string }): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO reactions (id, message_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(id('rct'), input.messageId, input.userId, input.emoji, nowIso());
  }

  findAttachmentById(attachmentId: string): Attachment | null {
    const row = this.db
      .prepare('SELECT id, file_name, mime_type, byte_size, path FROM attachments WHERE id = ?')
      .get(attachmentId) as AttachmentRow | undefined;
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      path: row.path,
    };
  }

  recordUploadedAttachment(input: {
    fileName: string;
    mimeType: string;
    byteSize: number;
    path: string;
  }): Attachment {
    const attachmentId = id('att');
    this.db
      .prepare(
        `
      INSERT INTO attachments (id, message_id, file_name, mime_type, byte_size, path, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?)
    `,
      )
      .run(attachmentId, input.fileName, input.mimeType, input.byteSize, input.path, nowIso());

    return {
      id: attachmentId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      path: input.path,
    };
  }

  private attachToMessage(attachment: Attachment, messageId: string): void {
    this.db
      .prepare(
        `
      UPDATE attachments
      SET message_id = ?
      WHERE id = ?
    `,
      )
      .run(messageId, attachment.id);
  }

  private loadAttachments(messageId: string): Attachment[] {
    const rows = this.db
      .prepare('SELECT id, file_name, mime_type, byte_size, path FROM attachments WHERE message_id = ?')
      .all(messageId) as unknown as AttachmentRow[];

    return rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      path: row.path,
    }));
  }

  private toMessage(row: MessageRow): Message {
    return {
      id: row.id,
      channelId: row.channel_id,
      authorId: row.author_id,
      content: row.content,
      parentMessageId: row.parent_message_id ?? undefined,
      gifUrl: row.gif_url ?? undefined,
      attachments: this.loadAttachments(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
      deletedAt: row.deleted_at ?? undefined,
    };
  }
}
