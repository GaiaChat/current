import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

export interface AuditLog {
  id: string;
  serverId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  payload: unknown;
  createdAt: string;
}

interface AuditRow {
  id: string;
  server_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  payload: string;
  created_at: string;
}

export class AuditRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  list(serverId: string, limit = 100): AuditLog[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs WHERE server_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(serverId, limit) as unknown as AuditRow[];

    return rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id ?? undefined,
      payload: this.json<unknown>(row.payload),
      createdAt: row.created_at,
    }));
  }

  create(input: Omit<AuditLog, 'id' | 'createdAt'>): AuditLog {
    const auditId = id('aud');
    const createdAt = nowIso();

    this.db
      .prepare(
        `
      INSERT INTO audit_logs (id, server_id, actor_id, action, target_type, target_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        auditId,
        input.serverId,
        input.actorId,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(input.payload),
        createdAt,
      );

    return {
      id: auditId,
      createdAt,
      ...input,
    };
  }
}
