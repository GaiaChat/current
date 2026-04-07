import type { VoiceState } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { MetricsService } from '../metrics/metrics-service.js';
import type { CurrentConfig } from '@current/config';
import { id } from '../utils/id.js';

export class VoiceService {
  constructor(
    private readonly repos: RepositoryBag,
    private readonly metrics: MetricsService,
    private readonly config: CurrentConfig,
  ) {}

  issueChannelToken(input: { userId: string; channelId: string }): {
    token: string;
    channelId: string;
    userId: string;
    rtc: {
      mode: 'mediasoup_sfu';
      listenIp: string;
      announcedIp: string;
      udpMinPort: number;
      udpMaxPort: number;
      turn: {
        urls: string[];
        username?: string;
        credential?: string;
      };
    };
  } {
    return {
      token: id('voice'),
      channelId: input.channelId,
      userId: input.userId,
      rtc: {
        mode: 'mediasoup_sfu',
        listenIp: this.config.rtc.listenIp,
        announcedIp: this.config.rtc.announcedIp,
        udpMinPort: this.config.rtc.udpMinPort,
        udpMaxPort: this.config.rtc.udpMaxPort,
        turn: {
          urls: this.config.rtc.turnUrls,
          username: this.config.rtc.turnUsername,
          credential: this.config.rtc.turnCredential,
        },
      },
    };
  }

  joinChannel(input: {
    userId: string;
    channelId: string;
    muted?: boolean;
    deafened?: boolean;
    pushToTalk?: boolean;
  }): VoiceState {
    this.metrics.incrementVoiceJoins();
    return this.repos.voiceStates.upsert({
      userId: input.userId,
      channelId: input.channelId,
      muted: Boolean(input.muted),
      deafened: Boolean(input.deafened),
      pushToTalk: Boolean(input.pushToTalk),
      speaking: false,
    });
  }

  leaveChannel(userId: string): void {
    this.repos.voiceStates.remove(userId);
  }

  patchState(input: {
    userId: string;
    muted?: boolean;
    deafened?: boolean;
    pushToTalk?: boolean;
    speaking?: boolean;
  }): VoiceState | null {
    const current = this.repos.voiceStates.getByUser(input.userId);
    if (!current) {
      return null;
    }

    return this.repos.voiceStates.upsert({
      userId: current.userId,
      channelId: current.channelId,
      muted: input.muted ?? current.muted,
      deafened: input.deafened ?? current.deafened,
      pushToTalk: input.pushToTalk ?? current.pushToTalk,
      speaking: input.speaking ?? current.speaking,
      connectedAt: current.connectedAt,
    });
  }

  getUserState(userId: string): VoiceState | null {
    return this.repos.voiceStates.getByUser(userId);
  }

  listState(): VoiceState[] {
    return this.repos.voiceStates.listAll();
  }

  listChannelState(channelId: string): VoiceState[] {
    return this.repos.voiceStates.listByChannel(channelId);
  }

  diagnostics() {
    return {
      transport: 'webrtc_sfu',
      provider: 'mediasoup',
      announcedIp: this.config.rtc.announcedIp,
      udpPortRange: {
        min: this.config.rtc.udpMinPort,
        max: this.config.rtc.udpMaxPort,
      },
      turnUrls: this.config.rtc.turnUrls,
      turnConfigured: this.config.rtc.turnUrls.length > 0,
    };
  }
}
