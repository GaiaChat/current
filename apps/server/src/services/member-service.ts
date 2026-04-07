import type { CurrentUser } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';

export class MemberService {
  constructor(private readonly repos: RepositoryBag) {}

  listMembers(serverId?: string): CurrentUser[] {
    const allMembers = this.repos.users.list();
    const visibleMembers = serverId
      ? allMembers.filter(
          (member) =>
            !this.repos.moderation.isBanned(serverId, member.id) &&
            !this.repos.moderation.isKicked(serverId, member.id),
        )
      : allMembers;

    return visibleMembers.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle));
  }

  recordClientIp(userId: string, ipAddress: string): void {
    this.repos.userIps.observe(userId, ipAddress);
  }

  listSharedIpGroups() {
    const byId = new Map(this.repos.users.list().map((user) => [user.id, user]));
    return this.repos.userIps.listSharedGroups().map((group) => ({
      ipAddress: group.ipAddress,
      userCount: group.userCount,
      lastSeenAt: group.lastSeenAt,
      totalHits: group.totalHits,
      users: group.userIds
        .map((id) => byId.get(id))
        .filter((user): user is CurrentUser => Boolean(user))
        .map((user) => ({
          id: user.id,
          handle: user.handle,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
        })),
    }));
  }
}
