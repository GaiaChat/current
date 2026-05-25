import type { CurrentConfig } from '@current/config';
import type { DatabaseSync } from 'node:sqlite';
import type { MetricsService } from '../metrics/metrics-service.js';
import type { AuthService } from '../auth/auth-service.js';
import type { SetupService } from '../setup/setup-service.js';
import type { ChatService } from '../services/chat-service.js';
import type { ModerationService } from '../services/moderation-service.js';
import type { InviteService } from '../services/invite-service.js';
import type { MemberService } from '../services/member-service.js';
import type { VoiceService } from '../voice/voice-service.js';
import type { VoiceScreenShareService } from '../voice/voice-screen-share-service.js';
import type { GatewayService } from '../realtime/gateway-service.js';
import type { ServerConfigService } from '../services/server-config-service.js';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { AtprotoBlockService } from '../services/atproto-block-service.js';

export interface AppContext {
  db: DatabaseSync;
  repos: RepositoryBag;
  config: CurrentConfig;
  configPath: string;
  metrics: MetricsService;
  auth: AuthService;
  setup: SetupService;
  chat: ChatService;
  moderation: ModerationService;
  invites: InviteService;
  members: MemberService;
  atprotoBlocks: AtprotoBlockService;
  voice: VoiceService;
  screenShare: VoiceScreenShareService;
  gateway: GatewayService;
  serverConfig: ServerConfigService;
}
