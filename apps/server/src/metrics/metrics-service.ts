export interface MetricsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  requests: number;
  errors: number;
  websocketConnections: number;
  messagesCreated: number;
  voiceJoins: number;
  moderationActions: number;
}

export class MetricsService {
  private readonly startedAt = new Date();
  private requests = 0;
  private errors = 0;
  private websocketConnections = 0;
  private messagesCreated = 0;
  private voiceJoins = 0;
  private moderationActions = 0;

  recordRequest(statusCode: number): void {
    this.requests += 1;
    if (statusCode >= 400) {
      this.errors += 1;
    }
  }

  onWsConnected(): void {
    this.websocketConnections += 1;
  }

  onWsDisconnected(): void {
    this.websocketConnections = Math.max(0, this.websocketConnections - 1);
  }

  incrementMessagesCreated(): void {
    this.messagesCreated += 1;
  }

  incrementVoiceJoins(): void {
    this.voiceJoins += 1;
  }

  incrementModerationActions(): void {
    this.moderationActions += 1;
  }

  snapshot(): MetricsSnapshot {
    const uptimeMs = Date.now() - this.startedAt.getTime();

    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      requests: this.requests,
      errors: this.errors,
      websocketConnections: this.websocketConnections,
      messagesCreated: this.messagesCreated,
      voiceJoins: this.voiceJoins,
      moderationActions: this.moderationActions,
    };
  }
}
