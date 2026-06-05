import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('setup owner assignment', () => {
  it('reports the port hosts need to forward during first-run setup', async () => {
    const { app, close } = await createTestApp();

    const setupStatusResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/setup/status',
    });

    expect(setupStatusResponse.statusCode).toBe(200);
    expect(setupStatusResponse.json()).toMatchObject({
      configured: false,
      network: {
        port: 6414,
        publicUrl: 'http://localhost:8080',
        serverAddress: 'http://localhost:8080',
      },
      ownership: {
        verificationRequired: true,
        verificationCodeLength: 8,
      },
    });

    await close();
  });

  it('rejects unauthenticated first-run setup from remote clients', async () => {
    const { app, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      remoteAddress: '10.22.33.44',
      payload: {
        serverName: 'Remote Setup',
        slug: 'remote-setup',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:remote-takeover',
        adminHandle: 'remote-takeover.bsky.social',
        adminDisplayName: 'Remote Takeover',
      },
    });

    expect(bootstrapResponse.statusCode).toBe(401);
    expect(bootstrapResponse.json()).toMatchObject({
      error: {
        code: 'SETUP_AUTH_REQUIRED',
      },
    });

    await close();
  });

  it('allows same-host headless setup to publish an HTTPS cloud URL', async () => {
    const { app, context, close } = await createTestApp();
    context.serverConfig.patchFullAdminSettings({
      auth: {
        atprotoClientId: '',
      },
    });

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'chat.example.com',
      },
      payload: {
        serverName: 'Cloud Current',
        slug: 'cloud-current',
        registrationMode: 'invite_only',
      },
    });

    expect(bootstrapResponse.statusCode).toBe(201);

    const config = context.serverConfig.get();
    expect(config.server.publicUrl).toBe('https://chat.example.com');
    expect(config.auth.redirectUri).toBe('https://chat.example.com/api/v1/auth/oauth/callback');
    expect(config.auth.atprotoClientId).toBe(
      'https://chat.example.com/api/v1/auth/client-metadata.json',
    );

    await close();
  });

  it('updates generated OAuth URLs when the Server address changes', async () => {
    const { context, close } = await createTestApp();
    context.serverConfig.patchFullAdminSettings({
      server: {
        publicUrl: 'https://old.example.com',
      },
      auth: {
        atprotoClientId: 'https://old.example.com/api/v1/auth/client-metadata.json',
        redirectUri: 'https://old.example.com/api/v1/auth/oauth/callback',
      },
    });

    const next = context.serverConfig.patchFullAdminSettings({
      server: {
        publicUrl: 'https://new.example.com',
      },
    });

    expect(next.auth.redirectUri).toBe('https://new.example.com/api/v1/auth/oauth/callback');
    expect(next.auth.atprotoClientId).toBe(
      'https://new.example.com/api/v1/auth/client-metadata.json',
    );

    await close();
  });

  it('does not auto-assign a remote signed-in user as owner without the terminal code', async () => {
    const { app, db, close } = await createTestApp();

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_remote_setup',
      'did:plc:remote-setup',
      'remote-setup.bsky.social',
      'Remote Setup',
      null,
      nowIso(),
      nowIso(),
    );
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('remote_setup_session', 'usr_remote_setup', addHours(1), nowIso());

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      remoteAddress: '10.10.10.10',
      cookies: {
        current_session: 'remote_setup_session',
      },
      payload: {
        serverName: 'Remote Code Server',
        slug: 'remote-code-server',
        serverAddress: 'https://chat.example.com',
        registrationMode: 'invite_only',
      },
    });

    expect(bootstrapResponse.statusCode).toBe(201);

    const ownerRecord = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('owner_user_id') as { value: string } | undefined;
    expect(ownerRecord).toBeUndefined();

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      remoteAddress: '10.10.10.10',
      cookies: {
        current_session: 'remote_setup_session',
      },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect((sessionResponse.json() as { ownership: { ownerUserId?: string } }).ownership.ownerUserId).toBeUndefined();

    await close();
  });

  it('assigns a remote signed-in user as owner with the terminal code and invalidates it', async () => {
    const { app, db, context, close } = await createTestApp();
    context.serverConfig.patchFullAdminSettings({
      auth: {
        atprotoClientId: '',
      },
    });

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_verified_setup',
      'did:plc:verified-setup',
      'verified-setup.bsky.social',
      'Verified Setup',
      null,
      nowIso(),
      nowIso(),
    );
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('verified_setup_session', 'usr_verified_setup', addHours(1), nowIso());

    const ownerCode = context.setup.createOwnerVerificationCode();
    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      remoteAddress: '10.10.10.20',
      cookies: {
        current_session: 'verified_setup_session',
      },
      payload: {
        serverName: 'Verified Code Server',
        slug: 'verified-code-server',
        serverAddress: 'https://verified.example.com',
        ownerVerificationCode: ownerCode.code,
        registrationMode: 'invite_only',
      },
    });

    expect(bootstrapResponse.statusCode).toBe(201);
    expect(context.setup.hasActiveOwnerVerificationCode()).toBe(false);

    const ownerRecord = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('owner_user_id') as { value: string } | undefined;
    expect(ownerRecord?.value).toBe('usr_verified_setup');
    expect(context.serverConfig.get().server.publicUrl).toBe('https://verified.example.com');
    expect(context.serverConfig.get().auth.redirectUri).toBe(
      'https://verified.example.com/api/v1/auth/oauth/callback',
    );

    await close();
  });

  it('applies onboarding preferences and returns the default landing channel', async () => {
    const { app, db, context, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Onboarding Server',
        slug: 'onboarding-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'manual_approval',
        initialPresenceStatus: 'away',
        media: {
          gifProvider: 'giphy',
          gifFallbackProvider: 'klipy',
          giphyApiKey: 'giphy-onboarding-key',
          maxAttachmentBytes: 12 * 1024 * 1024,
          allowedMimePrefixes: ['image/', 'video/'],
        },
        moderation: {
          defaultSlowmodeSeconds: 5,
          maxMentionsPerMessage: 4,
          linkPolicy: 'allow',
        },
        adminDid: 'did:plc:onboarding-owner',
        adminHandle: 'onboarding-owner.bsky.social',
        adminDisplayName: 'Onboarding Owner',
      },
    });

    expect(bootstrapResponse.statusCode).toBe(201);
    const bootstrapPayload = bootstrapResponse.json() as {
      serverId: string;
      defaultChannelId: string;
    };
    expect(bootstrapPayload.serverId).toBeTruthy();
    expect(bootstrapPayload.defaultChannelId).toBeTruthy();

    const config = context.serverConfig.get();
    expect(config.server.registrationMode).toBe('manual_approval');
    expect(config.media.gifProvider).toBe('giphy');
    expect(config.media.gifFallbackProvider).toBe('klipy');
    expect(config.media.giphyApiKey).toBe('giphy-onboarding-key');
    expect(config.media.maxAttachmentBytes).toBe(12 * 1024 * 1024);
    expect(config.media.allowedMimePrefixes).toEqual(['image/', 'video/']);
    expect(config.moderation.defaultSlowmodeSeconds).toBe(5);
    expect(config.moderation.maxMentionsPerMessage).toBe(4);
    expect(config.moderation.linkPolicy).toBe('allow');

    const channels = context.repos.channels.listAll(bootstrapPayload.serverId);
    expect(channels.map((channel) => channel.name)).toEqual(['general', 'lounge']);
    expect(channels[0]?.id).toBe(bootstrapPayload.defaultChannelId);
    expect(channels[0]?.slowmodeSeconds).toBe(5);

    const ownerPresence = db
      .prepare('SELECT selected_presence_status FROM users WHERE did = ?')
      .get('did:plc:onboarding-owner') as { selected_presence_status: string } | undefined;
    expect(ownerPresence?.selected_presence_status).toBe('away');

    await close();
  });

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
      INSERT INTO users (id, did, handle, display_name, avatar_url, bio, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_owner_claim',
      'did:plc:ownerclaim',
      'ownerclaim.bsky.social',
      'Owner Claim',
      'https://example.com/avatar.png',
      'Ready to claim ownership.',
      nowIso(),
      nowIso(),
    );

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
