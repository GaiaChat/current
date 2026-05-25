import { describe, expect, it, vi } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

type Relationship = {
  did: string;
  blocking?: string;
  blockedBy?: string;
  blockingByList?: string;
  blockedByList?: string;
};

function mockAtprotoRelationships(relationshipsByActor: Record<string, Record<string, Relationship>>) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.pathname !== '/xrpc/app.bsky.graph.getRelationships') {
      return new Response(JSON.stringify({}), { status: 404 });
    }

    const actor = (url.searchParams.get('actor') ?? '').toLowerCase();
    const others = url.searchParams.getAll('others').map((did) => did.toLowerCase());
    const relationships = others.map((did) => relationshipsByActor[actor]?.[did] ?? { did });
    return new Response(JSON.stringify({ actor, relationships }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  });
}

describe('atproto block-aware Current messages', () => {
  it('tombstones messages and suppresses notifications when either Bluesky side blocks the other', async () => {
    mockAtprotoRelationships({
      'did:plc:viewer': {
        'did:plc:blocked-author': {
          did: 'did:plc:blocked-author',
          blocking: 'at://did:plc:viewer/app.bsky.graph.block/blocked-author',
        },
        'did:plc:blocking-author': {
          did: 'did:plc:blocking-author',
          blockedBy: 'at://did:plc:blocking-author/app.bsky.graph.block/viewer',
        },
      },
      'did:plc:blocked-author': {
        'did:plc:viewer': {
          did: 'did:plc:viewer',
          blockedBy: 'at://did:plc:viewer/app.bsky.graph.block/blocked-author',
        },
      },
      'did:plc:blocking-author': {
        'did:plc:viewer': {
          did: 'did:plc:viewer',
          blocking: 'at://did:plc:blocking-author/app.bsky.graph.block/viewer',
        },
      },
    });

    const { app, db, context, close } = await createTestApp();
    try {
      const setupResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/bootstrap',
        payload: {
          serverName: 'ATProto Blocks',
          slug: 'atproto-blocks',
          publicUrl: 'http://localhost:8080',
          registrationMode: 'invite_only',
          adminDid: 'did:plc:viewer',
          adminHandle: 'viewer.bsky.social',
          adminDisplayName: 'Viewer',
        },
      });
      expect(setupResponse.statusCode).toBe(201);
      const setup = setupResponse.json() as { serverId: string; defaultChannelId: string };
      const viewer = db.prepare('SELECT id FROM users WHERE did = ?').get('did:plc:viewer') as { id: string };
      const memberRole = db
        .prepare("SELECT id FROM roles WHERE server_id = ? AND name = 'Member'")
        .get(setup.serverId) as { id: string };

      db.prepare(
        `
        INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        'usr_blocked_author',
        'did:plc:blocked-author',
        'blocked-author.bsky.social',
        'Blocked Author',
        null,
        nowIso(),
        nowIso(),
        'usr_blocking_author',
        'did:plc:blocking-author',
        'blocking-author.bsky.social',
        'Blocking Author',
        null,
        nowIso(),
        nowIso(),
        'usr_regular_author',
        'did:plc:regular-author',
        'regular-author.bsky.social',
        'Regular Author',
        null,
        nowIso(),
        nowIso(),
      );
      db.prepare(
        `
        INSERT INTO user_roles (user_id, role_id)
        VALUES (?, ?), (?, ?), (?, ?)
      `,
      ).run('usr_blocked_author', memberRole.id, 'usr_blocking_author', memberRole.id, 'usr_regular_author', memberRole.id);
      db.prepare(
        `
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)
      `,
      ).run(
        'viewer_session',
        viewer.id,
        addHours(1),
        nowIso(),
        'blocked_author_session',
        'usr_blocked_author',
        addHours(1),
        nowIso(),
        'blocking_author_session',
        'usr_blocking_author',
        addHours(1),
        nowIso(),
        'regular_author_session',
        'usr_regular_author',
        addHours(1),
        nowIso(),
      );

      const hiddenAttachment = context.chat.saveAttachment({
        fileName: 'hidden.png',
        mimeType: 'image/png',
        bytes: Buffer.from('hidden-image'),
        ownerUserId: 'usr_blocked_author',
      });

      const blockedPost = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
        cookies: {
          current_session: 'blocked_author_session',
        },
        payload: {
          content: 'hidden from viewer @viewer.bsky.social',
          gifUrl: 'https://example.com/hidden.gif',
          attachmentIds: [hiddenAttachment.id],
        },
      });
      expect(blockedPost.statusCode).toBe(201);
      const blockedMessage = blockedPost.json() as { id: string };

      const blockingPost = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
        cookies: {
          current_session: 'blocking_author_session',
        },
        payload: {
          content: 'also hidden from viewer @viewer.bsky.social',
        },
      });
      expect(blockingPost.statusCode).toBe(201);
      const blockingMessage = blockingPost.json() as { id: string };

      const visiblePost = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
        cookies: {
          current_session: 'regular_author_session',
        },
        payload: {
          content: 'visible to viewer',
        },
      });
      expect(visiblePost.statusCode).toBe(201);

      const messagesResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
        cookies: {
          current_session: 'viewer_session',
        },
      });
      expect(messagesResponse.statusCode).toBe(200);
      const messages = messagesResponse.json() as {
        items: Array<{
          id: string;
          content: string;
          gifUrl?: string;
          attachments?: unknown[];
          reactions?: unknown[];
          moderation?: {
            hidden: boolean;
            reason: string;
            viewerBlockedAuthor: boolean;
            authorBlockedViewer: boolean;
            disclaimer: string;
          };
        }>;
      };
      const viewerBlockedMessage = messages.items.find((message) => message.id === blockedMessage.id);
      expect(viewerBlockedMessage).toMatchObject({
        content: '',
        attachments: [],
        reactions: [],
        moderation: {
          hidden: true,
          reason: 'viewer_blocked_author',
          viewerBlockedAuthor: true,
          authorBlockedViewer: false,
        },
      });
      expect(viewerBlockedMessage?.gifUrl).toBeUndefined();
      expect(viewerBlockedMessage?.moderation?.disclaimer).toContain('you blocked this account on Bluesky');

      expect(messages.items.find((message) => message.id === blockingMessage.id)).toMatchObject({
        content: '',
        moderation: {
          hidden: true,
          reason: 'author_blocked_viewer',
          viewerBlockedAuthor: false,
          authorBlockedViewer: true,
        },
      });
      expect(messages.items.some((message) => message.content === 'visible to viewer')).toBe(true);

      const attachmentResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/media/attachments/${hiddenAttachment.id}`,
        cookies: {
          current_session: 'viewer_session',
        },
      });
      expect(attachmentResponse.statusCode).toBe(404);

      const reactionResponse = await app.inject({
        method: 'POST',
        url: `/api/v1/messages/${blockedMessage.id}/reactions`,
        cookies: {
          current_session: 'viewer_session',
        },
        payload: {
          emoji: '👍',
        },
      });
      expect(reactionResponse.statusCode).toBe(404);

      const notificationsResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/current?afterSeq=0&limit=20',
        cookies: {
          current_session: 'viewer_session',
        },
      });
      expect(notificationsResponse.statusCode).toBe(200);
      const notifications = notificationsResponse.json() as {
        items: Array<{ message: { id: string } }>;
      };
      expect(notifications.items.map((item) => item.message.id)).not.toContain(blockedMessage.id);
      expect(notifications.items.map((item) => item.message.id)).not.toContain(blockingMessage.id);
    } finally {
      await close();
      vi.unstubAllGlobals();
    }
  });
});
