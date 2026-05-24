import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { nowIso } from '../../utils/time.js';

export type ChannelNotificationLevel = 'default' | 'all' | 'mentions' | 'nothing';

export interface ChannelNotificationSetting {
  userId: string;
  channelId: string;
  notificationLevel: ChannelNotificationLevel;
  mutedUntil?: string;
  lastReadAt?: string;
  updatedAt: string;
}

interface ChannelNotificationSettingRow {
  user_id: string;
  channel_id: string;
  notification_level: string;
  muted_until: string | null;
  last_read_at: string | null;
  updated_at: string;
}

const VALID_NOTIFICATION_LEVELS = new Set<ChannelNotificationLevel>([
  'default',
  'all',
  'mentions',
  'nothing',
]);

function normalizeNotificationLevel(value: unknown): ChannelNotificationLevel {
  return typeof value === 'string' && VALID_NOTIFICATION_LEVELS.has(value as ChannelNotificationLevel)
    ? (value as ChannelNotificationLevel)
    : 'default';
}

export function effectiveChannelNotificationLevel(level: ChannelNotificationLevel): Exclude<ChannelNotificationLevel, 'default'> {
  return level === 'default' ? 'all' : level;
}

export function isChannelMuteActive(mutedUntil: string | undefined, now = Date.now()): boolean {
  if (!mutedUntil) {
    return false;
  }
  const timestamp = Date.parse(mutedUntil);
  return Number.isFinite(timestamp) && timestamp > now;
}

export class ChannelNotificationSettingsRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  defaultFor(userId: string, channelId: string): ChannelNotificationSetting {
    return {
      userId,
      channelId,
      notificationLevel: 'default',
      updatedAt: nowIso(),
    };
  }

  find(input: { userId: string; channelId: string }): ChannelNotificationSetting | null {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM channel_notification_settings
        WHERE user_id = ? AND channel_id = ?
      `,
      )
      .get(input.userId, input.channelId) as ChannelNotificationSettingRow | undefined;

    return row ? this.toSetting(row) : null;
  }

  findOrDefault(input: { userId: string; channelId: string }): ChannelNotificationSetting {
    return this.find(input) ?? this.defaultFor(input.userId, input.channelId);
  }

  listForUser(userId: string): ChannelNotificationSetting[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM channel_notification_settings
        WHERE user_id = ?
        ORDER BY channel_id ASC
      `,
      )
      .all(userId) as unknown as ChannelNotificationSettingRow[];

    return rows.map((row) => this.toSetting(row));
  }

  listForChannel(channelId: string): ChannelNotificationSetting[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM channel_notification_settings
        WHERE channel_id = ?
        ORDER BY user_id ASC
      `,
      )
      .all(channelId) as unknown as ChannelNotificationSettingRow[];

    return rows.map((row) => this.toSetting(row));
  }

  update(input: {
    userId: string;
    channelId: string;
    notificationLevel?: ChannelNotificationLevel;
    mutedUntil?: string | null;
    lastReadAt?: string;
  }): ChannelNotificationSetting {
    const existing = this.find(input);
    const next = {
      notificationLevel: input.notificationLevel ?? existing?.notificationLevel ?? 'default',
      mutedUntil: input.mutedUntil === undefined ? existing?.mutedUntil ?? null : input.mutedUntil,
      lastReadAt: input.lastReadAt ?? existing?.lastReadAt ?? null,
      updatedAt: nowIso(),
    };

    this.db
      .prepare(
        `
        INSERT INTO channel_notification_settings (
          user_id,
          channel_id,
          notification_level,
          muted_until,
          last_read_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, channel_id) DO UPDATE SET
          notification_level = excluded.notification_level,
          muted_until = excluded.muted_until,
          last_read_at = excluded.last_read_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.userId,
        input.channelId,
        next.notificationLevel,
        next.mutedUntil,
        next.lastReadAt,
        next.updatedAt,
      );

    return this.findOrDefault(input);
  }

  deleteForChannel(channelId: string): void {
    this.db.prepare('DELETE FROM channel_notification_settings WHERE channel_id = ?').run(channelId);
  }

  private toSetting(row: ChannelNotificationSettingRow): ChannelNotificationSetting {
    return {
      userId: row.user_id,
      channelId: row.channel_id,
      notificationLevel: normalizeNotificationLevel(row.notification_level),
      mutedUntil: row.muted_until ?? undefined,
      lastReadAt: row.last_read_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }
}
