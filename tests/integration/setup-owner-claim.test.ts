import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('setup owner assignment', () => {
  it('auto-assigns the first authenticated user as owner/admin when no owner exists', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Owner Claim Server',
        slug: 'owner-claim-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('usr_owner_claim', 'did:plc:ownerclaim', 'ownerclaim.bsky.social', 'Owner Claim', null, nowIso(), nowIso());

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('owner_claim_session', 'usr_owner_claim', addHours(1), nowIso());

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'owner_claim_session',
      },
    });
    expect(sessionResponse.statusCode).toBe(200);
    const sessionPayload = sessionResponse.json() as { user: { roleIds: string[] } };

    const rolesResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      cookies: {
        current_session: 'owner_claim_session',
      },
    });
    expect(rolesResponse.statusCode).toBe(200);
    const rolesPayload = rolesResponse.json() as Array<{ id: string; permissions: string[] }>;
    const adminRole = rolesPayload.find((role) => role.permissions.includes('ADMINISTRATOR'));
    expect(adminRole).toBeTruthy();
    if (!adminRole) {
      throw new Error('Expected bootstrap admin role to exist');
    }

    expect(sessionPayload.user.roleIds).toContain(adminRole.id);

    await close();
  });
});
