import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { nowIso } from '../../utils/time.js';

interface UserIpRow {
  user_id: string;
  ip_address: string;
  first_seen_at: string;
  last_seen_at: string;
  hit_count: number;
}

export interface SharedIpGroup {
  ipAddress: string;
  userIds: string[];
  userCount: number;
  lastSeenAt: string;
  totalHits: number;
}

export class UserIpRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  observe(userId: string, ipAddress: string): void {
    const normalizedIp = ipAddress.trim();
    if (!normalizedIp) {
      return;
    }

    const now = nowIso();
    this.db
      .prepare(
        `
      INSERT INTO user_ip_activity (user_id, ip_address, first_seen_at, last_seen_at, hit_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(user_id, ip_address) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        hit_count = user_ip_activity.hit_count + 1
    `,
      )
      .run(userId, normalizedIp, now, now);
  }

  listSharedGroups(): SharedIpGroup[] {
    const rows = this.db
      .prepare('SELECT * FROM user_ip_activity ORDER BY ip_address ASC, last_seen_at DESC')
      .all() as unknown as UserIpRow[];

    const grouped = new Map<string, { users: Set<string>; lastSeenAt: string; totalHits: number }>();
    for (const row of rows) {
      const existing = grouped.get(row.ip_address);
      if (existing) {
        existing.users.add(row.user_id);
        existing.totalHits += row.hit_count;
        if (row.last_seen_at > existing.lastSeenAt) {
          existing.lastSeenAt = row.last_seen_at;
        }
        continue;
      }

      grouped.set(row.ip_address, {
        users: new Set([row.user_id]),
        lastSeenAt: row.last_seen_at,
        totalHits: row.hit_count,
      });
    }

    return Array.from(grouped.entries())
      .map(([ipAddress, summary]) => ({
        ipAddress,
        userIds: Array.from(summary.users),
        userCount: summary.users.size,
        lastSeenAt: summary.lastSeenAt,
        totalHits: summary.totalHits,
      }))
      .filter((group) => group.userCount > 1)
      .sort((a, b) => {
        if (b.userCount !== a.userCount) {
          return b.userCount - a.userCount;
        }
        return b.lastSeenAt.localeCompare(a.lastSeenAt);
      });
  }
}
