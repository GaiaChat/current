import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';

export class SettingsRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  get<T = string>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as T;
    }
  }

  set<T>(key: string, value: T): void {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    this.db
      .prepare(
        `
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
      )
      .run(key, serialized);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
