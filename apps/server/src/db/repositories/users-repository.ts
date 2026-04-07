import type { CurrentUser } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { nowIso } from '../../utils/time.js';
import { id } from '../../utils/id.js';

interface UserRow {
  id: string;
  did: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export class UsersRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  upsertByDid(input: {
    did: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
  }): CurrentUser {
    const existing = this.db.prepare('SELECT id FROM users WHERE did = ?').get(input.did) as
      | { id: string }
      | undefined;

    const ts = nowIso();
    const userId = existing?.id ?? id('usr');

    this.db
      .prepare(
        `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at
    `,
      )
      .run(userId, input.did, input.handle, input.displayName, input.avatarUrl ?? null, ts, ts);

    return this.findById(userId)!;
  }

  findById(userId: string): CurrentUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | UserRow
      | undefined;
    if (!row) {
      return null;
    }

    const roleRows = this.db
      .prepare(
        `
      SELECT role_id
      FROM user_roles
      WHERE user_id = ?
    `,
      )
      .all(userId) as unknown as Array<{ role_id: string }>;

    return {
      id: row.id,
      did: row.did,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url ?? undefined,
      roleIds: roleRows.map((entry) => entry.role_id),
      createdAt: row.created_at,
    };
  }

  findByDid(did: string): CurrentUser | null {
    const row = this.db.prepare('SELECT id FROM users WHERE did = ?').get(did) as
      | { id: string }
      | undefined;
    return row ? this.findById(row.id) : null;
  }

  list(): CurrentUser[] {
    const rows = this.db.prepare('SELECT id FROM users ORDER BY created_at ASC').all() as unknown as Array<{ id: string }>;
    return rows.map((row) => this.findById(row.id)).filter((row): row is CurrentUser => Boolean(row));
  }

  addRole(userId: string, roleId: string): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO user_roles (user_id, role_id)
      VALUES (?, ?)
    `,
      )
      .run(userId, roleId);
  }

  removeRole(userId: string, roleId: string): void {
    this.db
      .prepare(
        `
      DELETE FROM user_roles
      WHERE user_id = ? AND role_id = ?
    `,
      )
      .run(userId, roleId);
  }

  hasAnyAssigneeForRole(roleId: string): boolean {
    const row = this.db
      .prepare(
        `
      SELECT 1
      FROM user_roles
      WHERE role_id = ?
      LIMIT 1
    `,
      )
      .get(roleId) as { 1: number } | undefined;

    return Boolean(row);
  }

  setSession(token: string, userId: string, expiresAt: string): void {
    this.db
      .prepare(
        `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(token, userId, expiresAt, nowIso());
  }

  clearSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  findUserBySession(token: string): CurrentUser | null {
    const row = this.db
      .prepare(
        `
      SELECT user_id, expires_at
      FROM sessions
      WHERE token = ?
    `,
      )
      .get(token) as { user_id: string; expires_at: string } | undefined;

    if (!row) {
      return null;
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.clearSession(token);
      return null;
    }

    return this.findById(row.user_id);
  }
}
