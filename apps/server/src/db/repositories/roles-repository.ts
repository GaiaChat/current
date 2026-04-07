import type { Permission, Role } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

interface RoleRow {
  id: string;
  server_id: string;
  name: string;
  color: string;
  position: number;
  permissions: string;
}

export class RolesRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  list(serverId: string): Role[] {
    const rows = this.db
      .prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC')
      .all(serverId) as unknown as RoleRow[];

    return rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      name: row.name,
      color: row.color,
      position: row.position,
      permissions: this.json<Permission[]>(row.permissions),
    }));
  }

  create(input: {
    serverId: string;
    name: string;
    color: string;
    permissions: Permission[];
    position: number;
  }): Role {
    const roleId = id('rol');
    this.db
      .prepare(
        `
      INSERT INTO roles (id, server_id, name, color, position, permissions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        roleId,
        input.serverId,
        input.name,
        input.color,
        input.position,
        JSON.stringify(input.permissions),
        nowIso(),
      );

    return {
      id: roleId,
      serverId: input.serverId,
      name: input.name,
      color: input.color,
      position: input.position,
      permissions: input.permissions,
    };
  }

  update(roleId: string, input: Partial<{ name: string; color: string; permissions: Permission[]; position: number }>): Role | null {
    const existing = this.db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as RoleRow | undefined;
    if (!existing) {
      return null;
    }

    const merged = {
      name: input.name ?? existing.name,
      color: input.color ?? existing.color,
      permissions: input.permissions ?? this.json<Permission[]>(existing.permissions),
      position: input.position ?? existing.position,
    };

    this.db
      .prepare(
        `
      UPDATE roles
      SET name = ?, color = ?, permissions = ?, position = ?
      WHERE id = ?
    `,
      )
      .run(merged.name, merged.color, JSON.stringify(merged.permissions), merged.position, roleId);

    return {
      id: roleId,
      serverId: existing.server_id,
      ...merged,
    };
  }

  delete(roleId: string): void {
    this.db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(roleId);
    this.db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
  }
}
