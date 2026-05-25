import type { CurrentConfig } from '@current/config';
import type { VoiceScreenShare } from '@current/types';
import { VoiceMediaShareService } from './voice-media-share-service.js';

export class VoiceScreenShareService extends VoiceMediaShareService<VoiceScreenShare> {
  constructor(getConfig: () => CurrentConfig) {
    super(getConfig, {
      kind: 'screen',
      idPrefix: 'vss',
      disabledMessage: 'Screen sharing is disabled on this server.',
      channelLimitMessage: 'This voice channel already has the maximum number of screen shares.',
      getSettings: (config) => config.rtc.screenShare,
    });
  }
}
