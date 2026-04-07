import type { Invite } from '@current/types';
import { nanoid } from 'nanoid';
import type { RepositoryBag } from '../db/repositories/index.js';

export class InviteService {
  constructor(private readonly repos: RepositoryBag) {}

  list(serverId: string): Invite[] {
    return this.repos.invites.list(serverId);
  }

  create(input: {
    serverId: string;
    createdBy: string;
    channelId?: string;
    maxUses?: number;
    expiresAt?: string;
  }): Invite {
    const code = nanoid(10);
    return this.repos.invites.create({
      code,
      serverId: input.serverId,
      channelId: input.channelId,
      maxUses: input.maxUses,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    });
  }

  revoke(code: string): void {
    this.repos.invites.revoke(code);
  }

  validate(code: string): { valid: boolean; reason?: string; invite?: Invite } {
    const invite = this.repos.invites.get(code);

    if (!invite) {
      return { valid: false, reason: 'Invite not found.' };
    }

    if (invite.revoked) {
      return { valid: false, reason: 'Invite revoked.' };
    }

    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      return { valid: false, reason: 'Invite expired.' };
    }

    if (typeof invite.maxUses === 'number' && invite.usedCount >= invite.maxUses) {
      return { valid: false, reason: 'Invite max uses reached.' };
    }

    return { valid: true, invite };
  }
}
