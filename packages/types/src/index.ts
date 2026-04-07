export type ISODate = string;

export type RegistrationMode = 'invite_only' | 'open_signup' | 'manual_approval';

export interface CurrentUser {
  id: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  roleIds: string[];
  createdAt: ISODate;
}

export interface CurrentServer {
  id: string;
  name: string;
  slug: string;
  registrationMode: RegistrationMode;
  createdAt: ISODate;
}

export interface Channel {
  id: string;
  serverId: string;
  categoryId?: string;
  name: string;
  type: 'text' | 'voice' | 'dm';
  topic?: string;
  slowmodeSeconds: number;
  locked: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  parentMessageId?: string;
  attachments?: Attachment[];
  gifUrl?: string;
  createdAt: ISODate;
  updatedAt?: ISODate;
  deletedAt?: ISODate;
}

export interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  path: string;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string;
  position: number;
  permissions: Permission[];
}

export type Permission =
  | 'ADMINISTRATOR'
  | 'MANAGE_SERVER'
  | 'MANAGE_CHANNELS'
  | 'MANAGE_ROLES'
  | 'MODERATE_MEMBERS'
  | 'MANAGE_MESSAGES'
  | 'SEND_MESSAGES'
  | 'CONNECT_VOICE'
  | 'SPEAK_VOICE'
  | 'ATTACH_FILES'
  | 'USE_GIFS';

export interface ChannelPermissionOverwrite {
  id: string;
  channelId: string;
  targetType: 'role' | 'user';
  targetId: string;
  allow: Permission[];
  deny: Permission[];
}

export interface Invite {
  code: string;
  serverId: string;
  channelId?: string;
  maxUses?: number;
  usedCount: number;
  expiresAt?: ISODate;
  createdBy: string;
  revoked?: boolean;
}

export interface AutomodRule {
  id: string;
  serverId: string;
  name: string;
  type: 'keyword' | 'regex' | 'mention_spam' | 'link_policy';
  enabled: boolean;
  payload: Record<string, unknown>;
  createdAt: ISODate;
}

export interface ModerationAction {
  id: string;
  serverId: string;
  actorId: string;
  targetUserId: string;
  type: 'ban' | 'mute' | 'timeout' | 'kick' | 'warn';
  reason?: string;
  expiresAt?: ISODate;
  createdAt: ISODate;
}

export interface VoiceState {
  userId: string;
  channelId: string;
  muted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
  speaking: boolean;
  connectedAt: ISODate;
}

export interface AckEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  payload: TPayload;
  sentAt: ISODate;
}
