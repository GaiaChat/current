import type {
  CurrentUser,
  Message,
  UserPresence,
  VoiceCameraShare,
  VoiceCameraShareSignal,
  VoiceProducer,
  VoiceScreenShare,
  VoiceScreenShareSignal,
  VoiceState,
} from '@current/types';

export type ClientEventType =
  | 'ACK'
  | 'PING'
  | 'MESSAGE_SEND'
  | 'MESSAGE_EDIT'
  | 'MESSAGE_DELETE'
  | 'VOICE_JOIN'
  | 'VOICE_LEAVE'
  | 'VOICE_STATE_PATCH'
  | 'PRESENCE_PATCH';

export type ServerEventType =
  | 'READY'
  | 'ACK'
  | 'PONG'
  | 'MESSAGE_CREATE'
  | 'MESSAGE_UPDATE'
  | 'MESSAGE_DELETE'
  | 'TYPING_UPDATE'
  | 'PRESENCE_UPDATE'
  | 'VOICE_STATE_UPDATE'
  | 'VOICE_PRODUCER_ADDED'
  | 'VOICE_PRODUCER_REMOVED'
  | 'VOICE_SCREEN_SHARE_STARTED'
  | 'VOICE_SCREEN_SHARE_STOPPED'
  | 'VOICE_SCREEN_SHARE_SIGNAL'
  | 'VOICE_CAMERA_SHARE_STARTED'
  | 'VOICE_CAMERA_SHARE_STOPPED'
  | 'VOICE_CAMERA_SHARE_SIGNAL'
  | 'VOICE_SPEAKING'
  | 'SERVER_UPDATE'
  | 'MEMBER_UPDATE'
  | 'NOTIFICATION_UPDATE'
  | 'MOD_ACTION'
  | 'ERROR';

export interface GatewayEnvelope<TType extends string = string, TPayload = unknown> {
  id: string;
  type: TType;
  payload: TPayload;
  seq?: number;
  sentAt: string;
}

export interface ReadyPayload {
  userId: string;
  serverId: string;
  lastEventSeq: number;
}

export interface MessageCreatePayload {
  message: Message;
  notification?: {
    mentionHandles?: string[];
    replyToUserId?: string;
  };
}

export interface MessageUpdatePayload {
  message: Message;
}

export interface MessageDeletePayload {
  messageId: string;
  channelId: string;
}

export interface TypingUpdatePayload {
  channelId: string;
  userId: string;
  isTyping: boolean;
}

export interface PresenceUpdatePayload {
  presence: UserPresence;
}

export interface VoiceStateUpdatePayload {
  voiceState: VoiceState | { userId: string; channelId: null };
}

export interface VoiceProducerAddedPayload {
  producer: VoiceProducer;
}

export interface VoiceProducerRemovedPayload {
  producerId: string;
  channelId: string;
  userId: string;
}

export interface VoiceSpeakingPayload {
  channelId: string;
  userId: string;
  speaking: boolean;
  volume?: number;
}

export interface VoiceScreenShareStartedPayload {
  screenShare: VoiceScreenShare;
}

export interface VoiceScreenShareStoppedPayload {
  shareId: string;
  channelId: string;
  userId: string;
}

export interface VoiceScreenShareSignalPayload {
  channelId: string;
  shareId: string;
  fromUserId: string;
  targetUserId: string;
  signal: VoiceScreenShareSignal;
}

export interface VoiceCameraShareStartedPayload {
  cameraShare: VoiceCameraShare;
}

export interface VoiceCameraShareStoppedPayload {
  shareId: string;
  channelId: string;
  userId: string;
}

export interface VoiceCameraShareSignalPayload {
  channelId: string;
  shareId: string;
  fromUserId: string;
  targetUserId: string;
  signal: VoiceCameraShareSignal;
}

export interface ModActionPayload {
  type: 'ban' | 'mute' | 'timeout' | 'kick' | 'warn';
  targetUserId: string;
  actorId: string;
  reason?: string;
}

export interface ServerUpdatePayload {
  server: unknown;
}

export interface MemberUpdatePayload {
  action: 'join' | 'leave' | 'kick' | 'ban' | 'role_update';
  userId: string;
  member?: CurrentUser;
  actorId?: string;
  reason?: string;
}

export interface NotificationUpdatePayload {
  action: 'channel_read' | 'channel_notification_settings';
  userId: string;
  channelId: string;
  readAt?: string;
  settings?: {
    userId: string;
    channelId: string;
    notificationLevel: 'default' | 'all' | 'mentions' | 'nothing';
    mutedUntil?: string;
    lastReadAt?: string;
    updatedAt: string;
  };
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface AckPayload {
  receivedId: string;
}

export const GatewayEvents = {
  READY: 'READY',
  ACK: 'ACK',
  PONG: 'PONG',
  MESSAGE_CREATE: 'MESSAGE_CREATE',
  MESSAGE_UPDATE: 'MESSAGE_UPDATE',
  MESSAGE_DELETE: 'MESSAGE_DELETE',
  TYPING_UPDATE: 'TYPING_UPDATE',
  PRESENCE_UPDATE: 'PRESENCE_UPDATE',
  VOICE_STATE_UPDATE: 'VOICE_STATE_UPDATE',
  VOICE_PRODUCER_ADDED: 'VOICE_PRODUCER_ADDED',
  VOICE_PRODUCER_REMOVED: 'VOICE_PRODUCER_REMOVED',
  VOICE_SCREEN_SHARE_STARTED: 'VOICE_SCREEN_SHARE_STARTED',
  VOICE_SCREEN_SHARE_STOPPED: 'VOICE_SCREEN_SHARE_STOPPED',
  VOICE_SCREEN_SHARE_SIGNAL: 'VOICE_SCREEN_SHARE_SIGNAL',
  VOICE_CAMERA_SHARE_STARTED: 'VOICE_CAMERA_SHARE_STARTED',
  VOICE_CAMERA_SHARE_STOPPED: 'VOICE_CAMERA_SHARE_STOPPED',
  VOICE_CAMERA_SHARE_SIGNAL: 'VOICE_CAMERA_SHARE_SIGNAL',
  VOICE_SPEAKING: 'VOICE_SPEAKING',
  SERVER_UPDATE: 'SERVER_UPDATE',
  MEMBER_UPDATE: 'MEMBER_UPDATE',
  NOTIFICATION_UPDATE: 'NOTIFICATION_UPDATE',
  MOD_ACTION: 'MOD_ACTION',
  ERROR: 'ERROR',
} as const;
