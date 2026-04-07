import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('invite policy checks', () => {
  it('validates invite exhaustion and expiry', async () => {
    const { context, close } = await createTestApp();

    context.setup.bootstrap({
      serverName: 'Test',
      slug: 'test',
      publicUrl: 'http://localhost:8080',
      registrationMode: 'invite_only',
      adminDid: 'did:plc:test',
      adminHandle: 'test.bsky.social',
      adminDisplayName: 'Test Admin',
    });

    const userId = context.db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:test') as { id: string };

    const invite = context.invites.create({
      serverId: context.setup.status().serverId!,
      createdBy: userId.id,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });

    const valid = context.invites.validate(invite.code);
    expect(valid.valid).toBe(true);

    context.db.prepare('UPDATE invites SET used_count = 1 WHERE code = ?').run(invite.code);
    const exhausted = context.invites.validate(invite.code);
    expect(exhausted.valid).toBe(false);

    await close();
  });
});
