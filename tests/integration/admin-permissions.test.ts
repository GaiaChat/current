import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('admin permission enforcement', () => {
  it('requires MANAGE_CHANNELS for channel create/update/delete APIs', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Permissions Server',
        slug: 'permissions-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);
    const { serverId } = bootstrapResponse.json() as { serverId: string };

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('usr_perm', 'did:plc:perm', 'perm.bsky.social', 'Perm User', null, nowIso(), nowIso());

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('perm_session', 'usr_perm', addHours(1), nowIso());

    const deniedCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'perm_session',
      },
      payload: {
        name: 'staff',
        type: 'text',
      },
    });
    expect(deniedCreate.statusCode).toBe(403);

    db.prepare(
      `
      INSERT INTO roles (id, server_id, name, color, position, permissions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'rol_manage_channels',
      serverId,
      'Channel Manager',
      '#6bd7ff',
      50,
      JSON.stringify(['MANAGE_CHANNELS']),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO user_roles (user_id, role_id)
      VALUES (?, ?)
    `,
    ).run('usr_perm', 'rol_manage_channels');

    const allowedCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'perm_session',
      },
      payload: {
        name: 'staff',
        type: 'text',
      },
    });
    expect(allowedCreate.statusCode).toBe(201);

    await close();
  });

  it('requires MODERATE_MEMBERS for moderation actions', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Moderation Server',
        slug: 'moderation-server',
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
      'usr_mod',
      'did:plc:mod',
      'mod.bsky.social',
      'Mod User',
      null,
      nowIso(),
      nowIso(),
      'usr_target',
      'did:plc:target',
      'target.bsky.social',
      'Target User',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('mod_session', 'usr_mod', addHours(1), nowIso());

    const deniedAction = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      cookies: {
        current_session: 'mod_session',
      },
      payload: {
        targetUserId: 'usr_target',
        type: 'warn',
      },
    });
    expect(deniedAction.statusCode).toBe(403);

    db.prepare(
      `
      INSERT INTO roles (id, server_id, name, color, position, permissions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'rol_moderator',
      serverId,
      'Moderator',
      '#f9a8ff',
      60,
      JSON.stringify(['MODERATE_MEMBERS']),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO user_roles (user_id, role_id)
      VALUES (?, ?)
    `,
    ).run('usr_mod', 'rol_moderator');

    const allowedAction = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      cookies: {
        current_session: 'mod_session',
      },
      payload: {
        targetUserId: 'usr_target',
        type: 'warn',
      },
    });
    expect(allowedAction.statusCode).toBe(201);

    await close();
  });
});
