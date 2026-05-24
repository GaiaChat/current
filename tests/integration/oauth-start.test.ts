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
});
