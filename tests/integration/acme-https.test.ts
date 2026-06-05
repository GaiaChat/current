import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('ACME HTTPS assistant', () => {
  it('issues a mocked certificate and updates TLS config for an owner admin', async () => {
    const { app, db, context, close } = await createTestApp({
      acmeModuleLoader: async () => ({
        crypto: {
          createPrivateKey: async () => 'mock-account-key',
          createCsr: async () => ['mock-domain-key', 'mock-csr'],
        },
        Client: class MockAcmeClient {
          constructor(_input: { directoryUrl: string; accountKey: string | Buffer }) {}

          async auto(input: {
            challengeCreateFn: (
              authz: unknown,
              challenge: { token: string },
              keyAuthorization: string,
            ) => Promise<void>;
            challengeRemoveFn: (
              authz: unknown,
              challenge: { token: string },
              keyAuthorization: string,
            ) => Promise<void>;
          }) {
            await input.challengeCreateFn({}, { token: 'mock-token' }, 'mock-token.mock-key');
            await input.challengeRemoveFn({}, { token: 'mock-token' }, 'mock-token.mock-key');
            return 'mock-certificate';
          }
        },
      }),
    });

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'ACME Server',
        slug: 'acme-server',
        serverAddress: 'https://chat.example.com',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:acme-owner',
        adminHandle: 'acme-owner.bsky.social',
        adminDisplayName: 'ACME Owner',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);

    const owner = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:acme-owner') as { id: string } | undefined;
    expect(owner?.id).toBeTruthy();
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('acme_owner_session', owner!.id, addHours(1), nowIso());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/https/acme/issue',
      cookies: {
        current_session: 'acme_owner_session',
      },
      payload: {
        email: 'owner@example.com',
        domain: 'chat.example.com',
      },
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'acme',
      enabled: true,
      domain: 'chat.example.com',
      restartRequired: true,
    });

    const config = context.serverConfig.get();
    expect(config.server.tls.acme.mode).toBe('acme');
    expect(config.server.tls.certPath).toContain('chat.example.com.crt');
    expect(config.server.tls.keyPath).toContain('chat.example.com.key');
    expect(existsSync(config.server.tls.certPath)).toBe(true);
    expect(existsSync(config.server.tls.keyPath)).toBe(true);
    expect(readFileSync(config.server.tls.certPath, 'utf8')).toBe('mock-certificate');
    expect(readFileSync(config.server.tls.keyPath, 'utf8')).toBe('mock-domain-key');

    await close();
  });
});
