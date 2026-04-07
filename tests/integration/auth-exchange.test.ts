import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('auth exchange route', () => {
  it('exchanges one-time auth ticket into session cookie', async () => {
    const { app, db, close } = await createTestApp();

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('user_exchange', 'did:plc:exchange', 'exchange.bsky.social', 'Exchange User', null, nowIso(), nowIso());

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('exchange_session', 'user_exchange', addHours(1), nowIso());

    db.prepare(
      `
      INSERT INTO settings (key, value)
      VALUES (?, ?)
    `,
    ).run(
      'auth:ticket:test-ticket',
      JSON.stringify({
        sessionToken: 'exchange_session',
        createdAt: Date.now(),
      }),
    );

    const exchangeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/exchange',
      payload: {
        ticket: 'test-ticket',
      },
    });

    expect(exchangeResponse.statusCode).toBe(204);
    const setCookie = exchangeResponse.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const sessionToken = rawCookie?.match(/current_session=([^;]+)/)?.[1];
    expect(sessionToken).toBe('exchange_session');

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'exchange_session',
      },
    });

    expect(sessionResponse.statusCode).toBe(200);

    await close();
  });
});
