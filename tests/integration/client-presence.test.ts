import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('client usage ping integration', () => {
  it('counts active browser clients and dedupes authenticated users as people', async () => {
    const { app, close } = await createTestApp();

    const firstPing = await app.inject({
      method: 'POST',
      url: '/api/v1/client/ping',
      payload: {
        clientId: 'browser-alpha-0001',
      },
    });

    expect(firstPing.statusCode).toBe(200);
    expect(firstPing.json()).toMatchObject({
      activeClients: 1,
      activePeople: 1,
      heartbeatSeconds: 15,
      ttlSeconds: 45,
    });

    const secondAnonymousPing = await app.inject({
      method: 'POST',
      url: '/api/v1/client/ping',
      payload: {
        clientId: 'browser-beta-0002',
      },
    });

    expect(secondAnonymousPing.statusCode).toBe(200);
    expect(secondAnonymousPing.json()).toMatchObject({
      activeClients: 2,
      activePeople: 2,
    });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'usage.tester@current',
        displayName: 'Usage Tester',
      },
    });
    expect(loginResponse.statusCode).toBe(200);
    const setCookie = loginResponse.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const sessionToken = rawCookie?.match(/current_session=([^;]+)/)?.[1];
    expect(sessionToken).toBeTruthy();
    if (!sessionToken) {
      throw new Error('Expected current_session cookie token');
    }

    const firstAuthenticatedPing = await app.inject({
      method: 'POST',
      url: '/api/v1/client/ping',
      cookies: {
        current_session: sessionToken,
      },
      payload: {
        clientId: 'browser-alpha-0001',
      },
    });

    expect(firstAuthenticatedPing.statusCode).toBe(200);
    expect(firstAuthenticatedPing.json()).toMatchObject({
      activeClients: 2,
      activePeople: 2,
    });

    const secondAuthenticatedPing = await app.inject({
      method: 'POST',
      url: '/api/v1/client/ping',
      cookies: {
        current_session: sessionToken,
      },
      payload: {
        clientId: 'browser-gamma-0003',
      },
    });

    expect(secondAuthenticatedPing.statusCode).toBe(200);
    expect(secondAuthenticatedPing.json()).toMatchObject({
      activeClients: 3,
      activePeople: 2,
    });

    expect(app.appContext.clientPresence.snapshot(Date.now() + 46_000)).toMatchObject({
      activeClients: 0,
      activePeople: 0,
    });

    await close();
  });

  it('rejects malformed client pings', async () => {
    const { app, close } = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/ping',
      payload: {
        clientId: '<script>',
      },
    });

    expect(response.statusCode).toBe(400);

    await close();
  });
});
