import type { VoiceState } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { nowIso } from '../../utils/time.js';

interface VoiceStateRow {
  user_id: string;
  channel_id: string;
  muted: number;
  deafened: number;
  push_to_talk: number;
  speaking: number;
  connected_at: string;
}

export class VoiceStatesRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  listAll(): VoiceState[] {
    const rows = this.db.prepare('SELECT * FROM voice_states').all() as unknown as VoiceStateRow[];
    return rows.map((row) => this.toVoiceState(row));
  }

  listByChannel(channelId: string): VoiceState[] {
    const rows = this.db.prepare('SELECT * FROM voice_states WHERE channel_id = ?').all(channelId) as unknown as VoiceStateRow[];
    return rows.map((row) => this.toVoiceState(row));
  }

  getByUser(userId: string): VoiceState | null {
    const row = this.db.prepare('SELECT * FROM voice_states WHERE user_id = ?').get(userId) as
      | VoiceStateRow
      | undefined;
    return row ? this.toVoiceState(row) : null;
  }

  upsert(input: Omit<VoiceState, 'connectedAt'> & { connectedAt?: string }): VoiceState {
    const connectedAt = input.connectedAt ?? nowIso();
    this.db
      .prepare(
        `
      INSERT INTO voice_states (user_id, channel_id, muted, deafened, push_to_talk, speaking, connected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        muted = excluded.muted,
        deafened = excluded.deafened,
        push_to_talk = excluded.push_to_talk,
        speaking = excluded.speaking,
        connected_at = excluded.connected_at
    `,
      )
      .run(
        input.userId,
        input.channelId,
        input.muted ? 1 : 0,
        input.deafened ? 1 : 0,
        input.pushToTalk ? 1 : 0,
        input.speaking ? 1 : 0,
        connectedAt,
      );

    return this.getByUser(input.userId)!;
  }

  remove(userId: string): void {
    this.db.prepare('DELETE FROM voice_states WHERE user_id = ?').run(userId);
  }

  private toVoiceState(row: VoiceStateRow): VoiceState {
    return {
      userId: row.user_id,
      channelId: row.channel_id,
      muted: Boolean(row.muted),
      deafened: Boolean(row.deafened),
      pushToTalk: Boolean(row.push_to_talk),
      speaking: Boolean(row.speaking),
      connectedAt: row.connected_at,
    };
  }
}
