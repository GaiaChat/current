import type { Server as HttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GatewayEnvelope } from '@current/protocol';
import { GatewayEvents } from '@current/protocol';
import type { CurrentUser } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { AuthService } from '../auth/auth-service.js';
import type { MetricsService } from '../metrics/metrics-service.js';
import { id } from '../utils/id.js';
import { nowIso } from '../utils/time.js';

interface ClientSession {
  socket: WebSocket;
  user: CurrentUser;
  lastAckedSeq: number;
}

export class GatewayService {
  private wsServer?: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientSession>();

  constructor(
    private readonly repos: RepositoryBag,
    private readonly auth: AuthService,
    private readonly metrics: MetricsService,
  ) {}

  attach(server: HttpServer): void {
    this.wsServer = new WebSocketServer({
      noServer: true,
      path: '/gateway',
    });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', 'http://localhost');
      if (url.pathname !== '/gateway') {
        return;
      }

      this.wsServer?.handleUpgrade(request, socket, head, (client) => {
        this.wsServer?.emit('connection', client, request);
      });
    });

    this.wsServer.on('connection', (socket, request) => {
      const user = this.authenticateWs(request);
      if (!user) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      const url = new URL(request.url ?? '', 'http://localhost');
      const lastSeq = Number(url.searchParams.get('lastEventSeq') ?? '0');

      const clientSession: ClientSession = {
        socket,
        user,
        lastAckedSeq: 0,
      };

      this.clients.set(socket, clientSession);
      this.metrics.onWsConnected();

      this.send(socket, {
        id: id('evt'),
        type: GatewayEvents.READY,
        payload: {
          userId: user.id,
          serverId: this.repos.servers.getPrimaryServer()?.id,
          lastEventSeq: this.repos.gatewayEvents.latestSeq(),
        },
        sentAt: nowIso(),
      });

      if (lastSeq > 0) {
        this.replaySince(socket, lastSeq);
      }

      socket.on('message', (raw) => this.handleClientMessage(socket, raw.toString('utf8')));
      socket.on('close', () => {
        this.clients.delete(socket);
        this.metrics.onWsDisconnected();
      });
    });
  }

  broadcast<T>(type: string, payload: T): number {
    const eventId = id('evt');
    const seq = this.repos.gatewayEvents.append({
      eventId,
      type,
      payload: payload as Record<string, unknown>,
    });

    const envelope: GatewayEnvelope = {
      id: eventId,
      type,
      payload,
      seq,
      sentAt: nowIso(),
    };

    for (const [socket] of this.clients) {
      this.send(socket, envelope);
    }

    return seq;
  }

  sendToUser<T>(userId: string, type: string, payload: T): void {
    const eventId = id('evt');
    const seq = this.repos.gatewayEvents.append({
      eventId,
      type,
      payload: payload as Record<string, unknown>,
    });

    const envelope: GatewayEnvelope = {
      id: eventId,
      type,
      payload,
      seq,
      sentAt: nowIso(),
    };

    for (const [socket, session] of this.clients) {
      if (session.user.id === userId) {
        this.send(socket, envelope);
      }
    }
  }

  private authenticateWs(request: IncomingMessage): CurrentUser | null {
    const url = new URL(request.url ?? '', 'http://localhost');
    const sessionToken =
      url.searchParams.get('session') ??
      this.readSessionFromCookieHeader(request.headers.cookie ?? undefined);

    return this.auth.getUserBySession(sessionToken ?? undefined);
  }

  private readSessionFromCookieHeader(cookieHeader?: string): string | null {
    if (!cookieHeader) {
      return null;
    }

    const target = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('current_session='));

    if (!target) {
      return null;
    }

    return decodeURIComponent(target.split('=')[1] ?? '');
  }

  private replaySince(socket: WebSocket, seq: number): void {
    const records = this.repos.gatewayEvents.listSince(seq);
    for (const record of records) {
      this.send(socket, {
        id: record.eventId,
        type: record.type,
        payload: record.payload,
        seq: record.seq,
        sentAt: record.createdAt,
      });
    }
  }

  private handleClientMessage(socket: WebSocket, raw: string): void {
    let envelope: GatewayEnvelope;
    try {
      envelope = JSON.parse(raw) as GatewayEnvelope;
    } catch {
      this.send(socket, {
        id: id('evt'),
        type: GatewayEvents.ERROR,
        payload: { code: 'BAD_PAYLOAD', message: 'Malformed gateway payload.' },
        sentAt: nowIso(),
      });
      return;
    }

    this.send(socket, {
      id: id('evt'),
      type: GatewayEvents.ACK,
      payload: {
        receivedId: envelope.id,
      },
      sentAt: nowIso(),
    });

    if (envelope.type === 'PING') {
      this.send(socket, {
        id: id('evt'),
        type: GatewayEvents.PONG,
        payload: {
          now: Date.now(),
        },
        sentAt: nowIso(),
      });
      return;
    }

    if (envelope.type === 'ACK') {
      const session = this.clients.get(socket);
      if (session && typeof envelope.payload === 'object' && envelope.payload) {
        const payload = envelope.payload as { seq?: number };
        if (typeof payload.seq === 'number') {
          session.lastAckedSeq = Math.max(payload.seq, session.lastAckedSeq);
        }
      }
    }
  }

  private send(socket: WebSocket, envelope: GatewayEnvelope): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(envelope));
    }
  }
}
