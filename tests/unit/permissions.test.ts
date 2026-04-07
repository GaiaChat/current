import { describe, expect, it } from 'vitest';
import { hasPermission, resolvePermissions } from '../../apps/server/src/moderation/permissions.js';

describe('permission resolution', () => {
  it('applies role and channel overwrites deterministically', () => {
    const permissions = resolvePermissions({
      userId: 'user_1',
      roleIds: ['member'],
      roles: [
        {
          id: 'member',
          serverId: 'server',
          name: 'Member',
          color: '#fff',
          position: 1,
          permissions: ['SEND_MESSAGES', 'CONNECT_VOICE'],
        },
      ],
      channelOverwrites: [
        {
          id: 'ow_1',
          channelId: 'channel',
          targetType: 'role',
          targetId: 'member',
          allow: [],
          deny: ['SEND_MESSAGES'],
        },
        {
          id: 'ow_2',
          channelId: 'channel',
          targetType: 'user',
          targetId: 'user_1',
          allow: ['SEND_MESSAGES'],
          deny: [],
        },
      ],
    });

    expect(hasPermission(permissions, 'SEND_MESSAGES')).toBe(true);
    expect(hasPermission(permissions, 'CONNECT_VOICE')).toBe(true);
  });
});
