import type { AutomodRule } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

interface AutomodRow {
  id: string;
  server_id: string;
  name: string;
  type: AutomodRule['type'];
  enabled: number;
  payload: string;
  created_at: string;
}

export class AutomodRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  list(serverId: string): AutomodRule[] {
    const rows = this.db.prepare('SELECT * FROM automod_rules WHERE server_id = ? ORDER BY created_at ASC').all(serverId) as unknown as AutomodRow[];
    return rows.map((row) => this.toRule(row));
  }

  create(input: Omit<AutomodRule, 'id' | 'createdAt'>): AutomodRule {
    const ruleId = id('amr');
    const createdAt = nowIso();

    this.db
      .prepare(
        `
      INSERT INTO automod_rules (id, server_id, name, type, enabled, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        ruleId,
        input.serverId,
        input.name,
        input.type,
        input.enabled ? 1 : 0,
        JSON.stringify(input.payload),
        createdAt,
        createdAt,
      );

    return {
      ...input,
      id: ruleId,
      createdAt,
    };
  }

  update(ruleId: string, patch: Partial<Omit<AutomodRule, 'id' | 'serverId' | 'createdAt'>>): AutomodRule | null {
    const existing = this.db.prepare('SELECT * FROM automod_rules WHERE id = ?').get(ruleId) as
      | AutomodRow
      | undefined;

    if (!existing) {
      return null;
    }

    const merged = {
      name: patch.name ?? existing.name,
      type: patch.type ?? existing.type,
      enabled: patch.enabled ?? Boolean(existing.enabled),
      payload: patch.payload ?? this.json<Record<string, unknown>>(existing.payload),
    };

    this.db
      .prepare(
        `
      UPDATE automod_rules
      SET name = ?, type = ?, enabled = ?, payload = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(merged.name, merged.type, merged.enabled ? 1 : 0, JSON.stringify(merged.payload), nowIso(), ruleId);

    return {
      id: existing.id,
      serverId: existing.server_id,
      name: merged.name,
      type: merged.type,
      enabled: merged.enabled,
      payload: merged.payload,
      createdAt: existing.created_at,
    };
  }

  delete(ruleId: string): void {
    this.db.prepare('DELETE FROM automod_rules WHERE id = ?').run(ruleId);
  }

  private toRule(row: AutomodRow): AutomodRule {
    return {
      id: row.id,
      serverId: row.server_id,
      name: row.name,
      type: row.type,
      enabled: Boolean(row.enabled),
      payload: this.json<Record<string, unknown>>(row.payload),
      createdAt: row.created_at,
    };
  }
}
