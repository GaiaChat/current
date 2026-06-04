import { describe, expect, it } from 'vitest';
import { DEFAULT_ATPROTO_OAUTH_SCOPE } from '@current/config';
import { createTestApp } from '../helpers/test-app.js';

describe('oauth start route', () => {
  it('requires a handle', async () => {
    const { app, close } = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/start',
    });

    expect(response.statusCode).toBe(400);

    await close();
  });

  it('passes did:plc identifiers through to the ATProto OAuth client', async () => {
    const { app, context, close } = await createTestApp();
    const seen: { handle?: string; scope?: string } = {};

    (
      context.auth as unknown as {
        getOAuthClient: () => Promise<{
          authorize: (handle: string, options: { scope: string }) => Promise<URL>;
        }>;
      }
    ).getOAuthClient = async () => ({
      authorize: async (handle, options) => {
        seen.handle = handle;
        seen.scope = options.scope;
        return new URL('https://auth.example/authorize');
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/start?handle=did%3Aplc%3AABC123',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authorizationUrl: 'https://auth.example/authorize',
    });
    expect(seen).toEqual({
      handle: 'did:plc:abc123',
      scope: DEFAULT_ATPROTO_OAUTH_SCOPE,
    });

    await close();
  });

  it('does not create a LAN handoff for remote loopback OAuth unless explicitly configured', async () => {
    const { app, context, close } = await createTestApp();
    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      server: {
        ...config.server,
        publicUrl: 'http://egg.hotandsteamysoup.com:6414',
      },
      auth: {
        ...config.auth,
        atprotoClientId: '',
        redirectUri: 'http://127.0.0.1:6414/api/v1/auth/oauth/callback',
        lanRedirectBaseUrl: '',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/auth/oauth/start?handle=test.bsky.social&returnTo=' +
        encodeURIComponent('http://egg.hotandsteamysoup.com:6414/channels'),
      remoteAddress: '10.22.33.44',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'LAN_HANDOFF_NOT_CONFIGURED',
        message:
          'This HTTP server is using loopback ATProto OAuth. LAN handoff is disabled until a LAN handoff base URL is configured in Server Settings.',
      },
    });

    await close();
  });

  it('creates a LAN handoff for remote loopback OAuth when explicitly configured', async () => {
    const { app, context, close } = await createTestApp();
    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      server: {
        ...config.server,
        publicUrl: 'http://egg.hotandsteamysoup.com:6414',
      },
      auth: {
        ...config.auth,
        atprotoClientId: '',
        redirectUri: 'http://127.0.0.1:6414/api/v1/auth/oauth/callback',
        lanRedirectBaseUrl: 'http://egg.hotandsteamysoup.com:6414',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/auth/oauth/start?handle=test.bsky.social&returnTo=' +
        encodeURIComponent('http://egg.hotandsteamysoup.com:6414/channels'),
      remoteAddress: '10.22.33.44',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      lanHandoff?: {
        hostAuthUrl: string;
        claimToken: string;
        expiresAt: string;
        message: string;
      };
    };
    expect(payload.lanHandoff?.hostAuthUrl).toMatch(
      /^http:\/\/egg\.hotandsteamysoup\.com:6414\/api\/v1\/auth\/lan\/handoffs\/[^/]+\/start$/,
    );
    expect(payload.lanHandoff?.claimToken).toBeTruthy();

    await close();
  });
});
