import type { CurrentServer, RegistrationMode } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

export class ServerRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  getPrimaryServer(): CurrentServer | null {
    const row = this.db.prepare('SELECT * FROM servers ORDER BY created_at ASC LIMIT 1').get() as
      | {
          id: string;
          name: string;
          slug: string;
          registration_mode: RegistrationMode;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      registrationMode: row.registration_mode,
      createdAt: row.created_at,
    };
  }

  create(input: { name: string; slug: string; registrationMode: RegistrationMode }): CurrentServer {
    const serverId = id('srv');
    const createdAt = nowIso();

    this.db
      .prepare(
        `
      INSERT INTO servers (id, name, slug, registration_mode, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(serverId, input.name, input.slug, input.registrationMode, createdAt);

    return {
      id: serverId,
      name: input.name,
      slug: input.slug,
      registrationMode: input.registrationMode,
      createdAt,
    };
  }

  updateRegistrationMode(serverId: string, registrationMode: RegistrationMode): void {
    this.db
      .prepare(
        `
      UPDATE servers
      SET registration_mode = ?
      WHERE id = ?
    `,
      )
      .run(registrationMode, serverId);
  }
}
