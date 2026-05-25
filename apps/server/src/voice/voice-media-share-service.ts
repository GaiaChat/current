import type { CurrentConfig } from '@current/config';
import type {
  VoiceMediaShare,
  VoiceMediaShareConstraints,
  VoiceMediaShareKind,
  VoiceMediaShareSettings,
} from '@current/types';
import { id } from '../utils/id.js';
import { nowIso } from '../utils/time.js';

interface VoiceMediaShareOptions {
  kind: VoiceMediaShareKind;
  idPrefix: string;
  disabledMessage: string;
  channelLimitMessage: string;
  getSettings: (config: CurrentConfig) => VoiceMediaShareSettings;
}

export class VoiceMediaShareService<TShare extends VoiceMediaShare = VoiceMediaShare> {
  private readonly shares = new Map<string, TShare>();

  constructor(
    private readonly getConfig: () => CurrentConfig,
    private readonly options: VoiceMediaShareOptions,
  ) {}

  getClientSettings(): VoiceMediaShareSettings {
    const config = this.options.getSettings(this.getConfig());
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
    share: TShare;
    stoppedShares: TShare[];
  } {
    const settings = this.getClientSettings();
    if (!settings.enabled) {
      throw new Error(this.options.disabledMessage);
    }

    const stoppedShares = this.stopUserShares(input.userId);
    const activeInChannel = this.listChannelShares(input.channelId).length;
    if (activeInChannel >= settings.maxActiveSharesPerChannel) {
      throw new Error(this.options.channelLimitMessage);
    }

    const share = {
      id: id(this.options.idPrefix),
      kind: this.options.kind,
      userId: input.userId,
      channelId: input.channelId,
      transportMode: settings.transportMode,
      constraints: this.toConstraints(settings),
      startedAt: nowIso(),
    } as TShare;
    this.shares.set(share.id, share);
    return { share, stoppedShares };
  }

  getShare(shareId: string): TShare | null {
    return this.shares.get(shareId) ?? null;
  }

  listChannelShares(channelId: string): TShare[] {
    return [...this.shares.values()]
      .filter((share) => share.channelId === channelId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  stopShare(input: { shareId: string; userId?: string }): TShare | null {
    const share = this.shares.get(input.shareId);
    if (!share) {
      return null;
    }
    if (input.userId && share.userId !== input.userId) {
      throw new Error(`${this.options.kind === 'camera' ? 'Camera' : 'Screen'} share not found.`);
    }
    this.shares.delete(share.id);
    return share;
  }

  stopUserShares(userId: string): TShare[] {
    const stopped: TShare[] = [];
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

  private toConstraints(settings: VoiceMediaShareSettings): VoiceMediaShareConstraints {
    return {
      maxWidth: settings.maxWidth,
      maxHeight: settings.maxHeight,
      maxFrameRate: settings.maxFrameRate,
      maxBitrateKbps: settings.maxBitrateKbps,
    };
  }
}
