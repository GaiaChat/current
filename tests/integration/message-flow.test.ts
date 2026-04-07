import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

describe('chat message integration', () => {
  it('boots setup and posts a message', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Integration',
        slug: 'integration',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:integration',
        adminHandle: 'integration.bsky.social',
        adminDisplayName: 'Integration Admin',
      },
    });

    expect(setupResponse.statusCode).toBe(201);

    const user = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:integration') as { id: string };

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('integration_session', user.id, addHours(1), nowIso());

    const channelsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'integration_session',
      },
    });

    expect(channelsResponse.statusCode).toBe(200);
    const channels = channelsResponse.json() as Array<{ id: string; type: string }>;
    const textChannel = channels.find((channel) => channel.type === 'text');
    expect(textChannel?.id).toBeDefined();

    const messageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        content: 'hello integration world',
      },
    });

    expect(messageResponse.statusCode).toBe(201);

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
    });

    expect(messagesResponse.statusCode).toBe(200);
    const messages = messagesResponse.json() as Array<{ content: string }>;
    expect(messages.some((msg) => msg.content === 'hello integration world')).toBe(true);

    await close();
  });
});
