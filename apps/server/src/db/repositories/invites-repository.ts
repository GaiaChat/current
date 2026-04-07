import type { Invite } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { nowIso } from '../../utils/time.js';

interface InviteRow {
  code: string;
  server_id: string;
  channel_id: string | null;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  created_by: string;
  revoked: number;
}

export class InvitesRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  list(serverId: string): Invite[] {
    const rows = this.db.prepare('SELECT * FROM invites WHERE server_id = ? ORDER BY created_at DESC').all(serverId) as unknown as InviteRow[];
    return rows.map((row) => this.toInvite(row));
  }

  create(input: {
    code: string;
    serverId: string;
    channelId?: string;
    maxUses?: number;
    expiresAt?: string;
    createdBy: string;
  }): Invite {
    this.db
      .prepare(
        `
      INSERT INTO invites (code, server_id, channel_id, max_uses, used_count, expires_at, created_by, created_at, revoked)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0)
    `,
      )
      .run(
        input.code,
        input.serverId,
        input.channelId ?? null,
        input.maxUses ?? null,
        input.expiresAt ?? null,
        input.createdBy,
        nowIso(),
      );

    return this.get(input.code)!;
  }

  get(code: string): Invite | null {
    const row = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as InviteRow | undefined;
    return row ? this.toInvite(row) : null;
  }

  revoke(code: string): void {
    this.db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(code);
  }

  consume(code: string): Invite | null {
    const invite = this.get(code);
    if (!invite) {
      return null;
    }

    this.db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(code);
    return this.get(code);
  }

  private toInvite(row: InviteRow): Invite {
    return {
      code: row.code,
      serverId: row.server_id,
      channelId: row.channel_id ?? undefined,
      maxUses: row.max_uses ?? undefined,
      usedCount: row.used_count,
      expiresAt: row.expires_at ?? undefined,
      createdBy: row.created_by,
      revoked: Boolean(row.revoked),
    };
  }
}
