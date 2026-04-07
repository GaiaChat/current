import type { ModerationAction } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

interface ModerationActionRow {
  id: string;
  server_id: string;
  actor_id: string;
  target_user_id: string;
  type: ModerationAction['type'];
  reason: string | null;
  expires_at: string | null;
  created_at: string;
}

export class ModerationRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  list(serverId: string, targetUserId?: string): ModerationAction[] {
    const rows = targetUserId
      ? (this.db
          .prepare(
            'SELECT * FROM moderation_actions WHERE server_id = ? AND target_user_id = ? ORDER BY created_at DESC',
          )
          .all(serverId, targetUserId) as unknown as ModerationActionRow[])
      : (this.db
          .prepare('SELECT * FROM moderation_actions WHERE server_id = ? ORDER BY created_at DESC')
          .all(serverId) as unknown as ModerationActionRow[]);

    return rows.map((row) => this.toAction(row));
  }

  create(input: Omit<ModerationAction, 'id' | 'createdAt'>): ModerationAction {
    const actionId = id('mod');
    const createdAt = nowIso();

    this.db
      .prepare(
        `
      INSERT INTO moderation_actions (id, server_id, actor_id, target_user_id, type, reason, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        actionId,
        input.serverId,
        input.actorId,
        input.targetUserId,
        input.type,
        input.reason ?? null,
        input.expiresAt ?? null,
        createdAt,
      );

    return {
      ...input,
      id: actionId,
      createdAt,
    };
  }

  isBanned(serverId: string, userId: string): boolean {
    const row = this.db
      .prepare(
        `
      SELECT id
      FROM moderation_actions
      WHERE server_id = ?
      AND target_user_id = ?
      AND type = 'ban'
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(serverId, userId) as { id: string } | undefined;

    return Boolean(row);
  }

  isKicked(serverId: string, userId: string): boolean {
    const row = this.db
      .prepare(
        `
      SELECT id
      FROM moderation_actions
      WHERE server_id = ?
      AND target_user_id = ?
      AND type = 'kick'
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(serverId, userId) as { id: string } | undefined;

    return Boolean(row);
  }

  activeTimeoutUntil(serverId: string, userId: string): string | null {
    const row = this.db
      .prepare(
        `
      SELECT expires_at
      FROM moderation_actions
      WHERE server_id = ?
      AND target_user_id = ?
      AND type IN ('mute', 'timeout')
      AND expires_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(serverId, userId) as { expires_at: string | null } | undefined;

    if (!row?.expires_at) {
      return null;
    }

    return new Date(row.expires_at).getTime() > Date.now() ? row.expires_at : null;
  }

  private toAction(row: ModerationActionRow): ModerationAction {
    return {
      id: row.id,
      serverId: row.server_id,
      actorId: row.actor_id,
      targetUserId: row.target_user_id,
      type: row.type,
      reason: row.reason ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      createdAt: row.created_at,
    };
  }
}
