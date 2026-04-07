import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('auth session logic', () => {
  it('rejects expired sessions and accepts active sessions', async () => {
    const { context, db, close } = await createTestApp();

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('user_1', 'did:plc:abc', 'abc.bsky.social', 'ABC', null, nowIso(), nowIso());

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('expired', 'user_1', new Date(Date.now() - 10_000).toISOString(), nowIso());

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('active', 'user_1', addHours(1), nowIso());

    expect(context.auth.getUserBySession('expired')).toBeNull();
    expect(context.auth.getUserBySession('active')?.id).toBe('user_1');

    await close();
  });
});
