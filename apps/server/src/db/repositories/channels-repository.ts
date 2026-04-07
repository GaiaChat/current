import type { Channel, ChannelPermissionOverwrite, Permission } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

interface ChannelRow {
  id: string;
  server_id: string;
  category_id: string | null;
  name: string;
  type: 'text' | 'voice' | 'dm';
  topic: string | null;
  slowmode_seconds: number;
  locked: number;
}

interface OverwriteRow {
  id: string;
  channel_id: string;
  target_type: 'role' | 'user';
  target_id: string;
  allow_permissions: string;
  deny_permissions: string;
}

export class ChannelsRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  list(serverId: string): Channel[] {
    const rows = this.db
      .prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY created_at ASC')
      .all(serverId) as unknown as ChannelRow[];

    return rows.map((row) => this.toChannel(row));
  }

  findById(channelId: string): Channel | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as
      | ChannelRow
      | undefined;
    return row ? this.toChannel(row) : null;
  }

  create(input: {
    serverId: string;
    categoryId?: string;
    name: string;
    type: 'text' | 'voice' | 'dm';
    topic?: string;
    slowmodeSeconds?: number;
  }): Channel {
    const channelId = id('chn');
    this.db
      .prepare(
        `
      INSERT INTO channels (id, server_id, category_id, name, type, topic, slowmode_seconds, locked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `,
      )
      .run(
        channelId,
        input.serverId,
        input.categoryId ?? null,
        input.name,
        input.type,
        input.topic ?? null,
        input.slowmodeSeconds ?? 0,
        nowIso(),
      );

    return this.findById(channelId)!;
  }

  update(channelId: string, input: Partial<Omit<Channel, 'id' | 'serverId'>>): Channel | null {
    const existing = this.findById(channelId);
    if (!existing) {
      return null;
    }

    const merged = {
      categoryId: input.categoryId ?? existing.categoryId,
      name: input.name ?? existing.name,
      type: input.type ?? existing.type,
      topic: input.topic ?? existing.topic,
      slowmodeSeconds: input.slowmodeSeconds ?? existing.slowmodeSeconds,
      locked: input.locked ?? existing.locked,
    };

    this.db
      .prepare(
        `
      UPDATE channels
      SET category_id = ?, name = ?, type = ?, topic = ?, slowmode_seconds = ?, locked = ?
      WHERE id = ?
    `,
      )
      .run(
        merged.categoryId ?? null,
        merged.name,
        merged.type,
        merged.topic ?? null,
        merged.slowmodeSeconds,
        merged.locked ? 1 : 0,
        channelId,
      );

    return this.findById(channelId);
  }

  delete(channelId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `
        DELETE FROM reactions
        WHERE message_id IN (
          SELECT id FROM messages WHERE channel_id = ?
        )
      `,
        )
        .run(channelId);

      this.db
        .prepare(
          `
        DELETE FROM attachments
        WHERE message_id IN (
          SELECT id FROM messages WHERE channel_id = ?
        )
      `,
        )
        .run(channelId);

      this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM voice_states WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM invites WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM channel_overwrites WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listOverwrites(channelId: string): ChannelPermissionOverwrite[] {
    const rows = this.db
      .prepare('SELECT * FROM channel_overwrites WHERE channel_id = ?')
      .all(channelId) as unknown as OverwriteRow[];

    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      targetType: row.target_type,
      targetId: row.target_id,
      allow: this.json<Permission[]>(row.allow_permissions),
      deny: this.json<Permission[]>(row.deny_permissions),
    }));
  }

  upsertOverwrite(input: {
    channelId: string;
    targetType: 'role' | 'user';
    targetId: string;
    allow: Permission[];
    deny: Permission[];
  }): ChannelPermissionOverwrite {
    const existing = this.db
      .prepare(
        `
      SELECT id FROM channel_overwrites
      WHERE channel_id = ? AND target_type = ? AND target_id = ?
    `,
      )
      .get(input.channelId, input.targetType, input.targetId) as { id: string } | undefined;

    const overwriteId = existing?.id ?? id('ovr');

    this.db
      .prepare(
        `
      INSERT INTO channel_overwrites (id, channel_id, target_type, target_id, allow_permissions, deny_permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        allow_permissions = excluded.allow_permissions,
        deny_permissions = excluded.deny_permissions
    `,
      )
      .run(
        overwriteId,
        input.channelId,
        input.targetType,
        input.targetId,
        JSON.stringify(input.allow),
        JSON.stringify(input.deny),
      );

    return {
      id: overwriteId,
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      allow: input.allow,
      deny: input.deny,
    };
  }

  private toChannel(row: ChannelRow): Channel {
    return {
      id: row.id,
      serverId: row.server_id,
      categoryId: row.category_id ?? undefined,
      name: row.name,
      type: row.type,
      topic: row.topic ?? undefined,
      slowmodeSeconds: row.slowmode_seconds,
      locked: Boolean(row.locked),
    };
  }
}
