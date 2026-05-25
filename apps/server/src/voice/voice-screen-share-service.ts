import type { CurrentConfig } from '@current/config';
import type {
  VoiceScreenShare,
  VoiceScreenShareConstraints,
  VoiceScreenShareSettings,
} from '@current/types';
import { id } from '../utils/id.js';
import { nowIso } from '../utils/time.js';

export class VoiceScreenShareService {
  private readonly shares = new Map<string, VoiceScreenShare>();

  constructor(private readonly getConfig: () => CurrentConfig) {}

  getClientSettings(): VoiceScreenShareSettings {
    const config = this.getConfig().rtc.screenShare;
    return {
      enabled: config.enabled,
      transportMode: config.transportMode,
      maxWidth: config.maxWidth,
      maxHeight: config.maxHeight,
      maxFrameRate: config.maxFrameRate,
      maxBitrateKbps: config.maxBitrateKbps,
      maxActiveSharesPerChannel: config.maxActiveSharesPerChannel,
    };
  }

  startShare(input: { userId: string; channelId: string }): {
    share: VoiceScreenShare;
    stoppedShares: VoiceScreenShare[];
  } {
    const settings = this.getClientSettings();
    if (!settings.enabled) {
      throw new Error('Screen sharing is disabled on this server.');
    }

    const stoppedShares = this.stopUserShares(input.userId);
    const activeInChannel = this.listChannelShares(input.channelId).length;
    if (activeInChannel >= settings.maxActiveSharesPerChannel) {
      throw new Error('This voice channel already has the maximum number of screen shares.');
    }

    const share: VoiceScreenShare = {
      id: id('vss'),
      userId: input.userId,
      channelId: input.channelId,
      transportMode: settings.transportMode,
      constraints: this.toConstraints(settings),
      startedAt: nowIso(),
    };
    this.shares.set(share.id, share);
    return { share, stoppedShares };
  }

  getShare(shareId: string): VoiceScreenShare | null {
    return this.shares.get(shareId) ?? null;
  }

  listChannelShares(channelId: string): VoiceScreenShare[] {
    return [...this.shares.values()]
      .filter((share) => share.channelId === channelId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  stopShare(input: { shareId: string; userId?: string }): VoiceScreenShare | null {
    const share = this.shares.get(input.shareId);
    if (!share) {
      return null;
    }
    if (input.userId && share.userId !== input.userId) {
      throw new Error('Screen share not found.');
    }
    this.shares.delete(share.id);
    return share;
  }

  stopUserShares(userId: string): VoiceScreenShare[] {
    const stopped: VoiceScreenShare[] = [];
    for (const share of [...this.shares.values()]) {
      if (share.userId !== userId) {
        continue;
      }
      this.shares.delete(share.id);
      stopped.push(share);
    }
    return stopped;
  }

  close(): void {
    this.shares.clear();
  }

  private toConstraints(settings: VoiceScreenShareSettings): VoiceScreenShareConstraints {
    return {
      maxWidth: settings.maxWidth,
      maxHeight: settings.maxHeight,
      maxFrameRate: settings.maxFrameRate,
      maxBitrateKbps: settings.maxBitrateKbps,
    };
  }
}
