import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('gif search fallback', () => {
  it('returns an empty payload with providerError when Klipy is not configured', async () => {
    const { app, db, context, close } = await createTestApp();

    context.serverConfig.patchAdminSettings({
      klipyApiKey: '',
    });

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_gif',
      'did:plc:gif',
      'gif-user.bsky.social',
      'Gif User',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('gif_session', 'usr_gif', addHours(1), nowIso());

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/media/gifs/search?q=Trending%20GIFs&limit=36',
      cookies: {
        current_session: 'gif_session',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      results?: unknown[];
      provider?: string;
      providerError?: { code?: string; message?: string };
    };
    expect(payload.provider).toBe('klipy');
    expect(payload.results).toEqual([]);
    expect(payload.providerError?.code).toBe('KLIPY_ERROR');
    expect(payload.providerError?.message).toContain('Klipy API key is not configured');

    await close();
  });
});
