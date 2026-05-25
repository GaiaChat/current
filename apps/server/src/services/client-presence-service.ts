import type { ClientUsageSnapshot } from '@current/types';

const DEFAULT_CLIENT_PRESENCE_TTL_MS = 45_000;
const DEFAULT_CLIENT_PRESENCE_HEARTBEAT_MS = 15_000;

interface ClientPresenceEntry {
  clientId: string;
  userId?: string;
  lastSeenAt: number;
}

export class ClientPresenceService {
  private readonly clients = new Map<string, ClientPresenceEntry>();
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;

  constructor(options: { ttlMs?: number; heartbeatMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CLIENT_PRESENCE_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_CLIENT_PRESENCE_HEARTBEAT_MS;
  }

  recordPing(input: {
    clientId: string;
    userId?: string | null;
    now?: number;
  }): ClientUsageSnapshot {
    const now = input.now ?? Date.now();
    this.prune(now);
    this.clients.set(input.clientId, {
      clientId: input.clientId,
      userId: input.userId ?? undefined,
      lastSeenAt: now,
    });
    return this.snapshot(now);
  }

  snapshot(now = Date.now()): ClientUsageSnapshot {
    this.prune(now);

    const activeUsers = new Set<string>();
    let anonymousClients = 0;

    for (const client of this.clients.values()) {
      if (client.userId) {
        activeUsers.add(client.userId);
      } else {
        anonymousClients += 1;
      }
    }

    return {
      activeClients: this.clients.size,
      activePeople: activeUsers.size + anonymousClients,
      heartbeatSeconds: Math.ceil(this.heartbeatMs / 1_000),
      ttlSeconds: Math.ceil(this.ttlMs / 1_000),
      updatedAt: new Date(now).toISOString(),
    };
  }

  private prune(now: number): void {
    const staleBefore = now - this.ttlMs;
    for (const [clientId, client] of this.clients) {
      if (client.lastSeenAt < staleBefore) {
        this.clients.delete(clientId);
      }
    }
  }
}
