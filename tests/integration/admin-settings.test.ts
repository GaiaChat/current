import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('admin settings and insights', () => {
  it('requires MANAGE_SERVER and supports settings, ownership transfer, and shared-ip insights', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Admin Server',
        slug: 'admin-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);
    const { serverId } = bootstrapResponse.json() as { serverId: string };

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_admin',
      'did:plc:admin',
      'admin.bsky.social',
      'Admin User',
      null,
      nowIso(),
      nowIso(),
      'usr_member',
      'did:plc:member',
      'member.bsky.social',
      'Member User',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `,
    ).run(
      'admin_session',
      'usr_admin',
      addHours(1),
      nowIso(),
      'member_session',
      'usr_member',
      addHours(1),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO roles (id, server_id, name, color, position, permissions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'rol_manage_server',
      serverId,
      'Server Admin',
      '#30b4ff',
      90,
      JSON.stringify(['MANAGE_SERVER']),
      nowIso(),
    );

    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('usr_admin', 'rol_manage_server');

    const deniedSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'member_session',
      },
    });
    expect(deniedSettings.statusCode).toBe(403);

    const allowedSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'admin_session',
      },
    });
    expect(allowedSettings.statusCode).toBe(200);

    const patchSettings = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'admin_session',
      },
      payload: {
        klipyApiKey: 'new-test-key',
        registrationMode: 'manual_approval',
      },
    });
    expect(patchSettings.statusCode).toBe(200);
    const patched = patchSettings.json() as { media: { klipyApiKey: string }; server: { registrationMode: string } };
    expect(patched.media.klipyApiKey).toBe('new-test-key');
    expect(patched.server.registrationMode).toBe('manual_approval');

    const transferOwnership = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/ownership/transfer',
      cookies: {
        current_session: 'admin_session',
      },
      payload: {
        targetUserId: 'usr_member',
      },
    });
    expect(transferOwnership.statusCode).toBe(200);
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('owner_user_id')).toBeTruthy();

    await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'admin_session',
      },
    });
    await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'member_session',
      },
    });

    const sharedIps = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/shared-ips',
      cookies: {
        current_session: 'admin_session',
      },
    });
    expect(sharedIps.statusCode).toBe(200);
    const groups = sharedIps.json() as Array<{ ipAddress: string; userCount: number }>;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]?.userCount).toBeGreaterThanOrEqual(2);

    await close();
  });
});
