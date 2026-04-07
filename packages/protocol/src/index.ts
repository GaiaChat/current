import type { Message, VoiceState } from '@current/types';

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
  | 'PRESENCE_UPDATE'
  | 'VOICE_STATE_UPDATE'
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
}

export interface MessageUpdatePayload {
  message: Message;
}

export interface MessageDeletePayload {
  messageId: string;
  channelId: string;
}

export interface VoiceStateUpdatePayload {
  voiceState: VoiceState;
}

export interface ModActionPayload {
  type: 'ban' | 'mute' | 'timeout' | 'kick' | 'warn';
  targetUserId: string;
  actorId: string;
  reason?: string;
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
  PRESENCE_UPDATE: 'PRESENCE_UPDATE',
  VOICE_STATE_UPDATE: 'VOICE_STATE_UPDATE',
  MOD_ACTION: 'MOD_ACTION',
  ERROR: 'ERROR',
} as const;
