import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Channel, Message, VoiceState } from '@current/types';
import { apiDelete, apiGet, apiPatch, apiPost, uploadAttachment } from '../lib/api';
import { useGateway } from '../hooks/useGateway';
import { ServerSettingsModal } from './server-settings-modal';

type SetupStatus = {
  configured: boolean;
  serverId?: string;
};

type SessionPayload = {
  user: {
    id: string;
    did: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
    roleIds: string[];
  };
  server: {
    name: string;
    registrationMode: 'invite_only' | 'open_signup' | 'manual_approval';
  };
};

type OAuthLanHandoffPayload = {
  handoffId: string;
  hostAuthUrl: string;
  expiresAt: string;
  message?: string;
};

type OAuthStartPayload = {
  authorizationUrl?: string;
  lanHandoff?: OAuthLanHandoffPayload;
};

type OAuthLanHandoffStatusPayload = {
  status: 'pending' | 'ready' | 'claimed' | 'expired';
  expiresAt?: string;
};

type MemberPayload = {
  id: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  roleIds: string[];
  createdAt: string;
};

type RolePayload = {
  id: string;
  name: string;
  permissions: string[];
};

type ContextMenuState =
  | {
      kind: 'server';
      x: number;
      y: number;
    }
  | {
      kind: 'channel';
      x: number;
      y: number;
      channel: Channel;
    }
  | {
      kind: 'member';
      x: number;
      y: number;
      member: SessionPayload['user'] | MemberPayload;
    }
  | null;

type GifSearchResult = {
  id?: string;
  content_description?: string;
  media_formats?: {
    gif?: { url?: string };
    tinygif?: { url?: string };
  };
};

type GifSearchResponse = {
  results?: GifSearchResult[];
  provider?: string;
  providerError?: {
    code?: string;
    message?: string;
  };
};

const GIF_QUICK_TOPICS = [
  'Favorites',
  'Trending GIFs',
  'tired bunny',
  'monday face',
  'masters',
  'morning coffee',
];
const MAX_GIF_RESULTS = 9;

export function App() {
  const queryClient = useQueryClient();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [gifUrl, setGifUrl] = useState<string | undefined>();
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [gifTab, setGifTab] = useState<'gifs' | 'stickers' | 'emoji'>('gifs');
  const [isGifModalOpen, setIsGifModalOpen] = useState(false);
  const [gifSearchInput, setGifSearchInput] = useState('');
  const [gifSearchQuery, setGifSearchQuery] = useState('Trending GIFs');
  const [isExchangingAuth, setIsExchangingAuth] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [isServerSettingsOpen, setIsServerSettingsOpen] = useState(false);

  useEffect(() => {
    const current = new URL(window.location.href);
    const ticket = current.searchParams.get('current_auth_ticket');
    if (!ticket) {
      return;
    }

    setIsExchangingAuth(true);
    void apiPost<void>('/api/v1/auth/exchange', { ticket })
      .then(() => {
        current.searchParams.delete('current_auth_ticket');
        window.location.replace(current.toString());
      })
      .catch(() => {
        setIsExchangingAuth(false);
      });
  }, []);

  const setupQuery = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => apiGet<SetupStatus>('/api/v1/setup/status'),
    refetchInterval: 10_000,
  });

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => apiGet<SessionPayload>('/api/v1/auth/session'),
    enabled: Boolean(setupQuery.data),
    retry: false,
  });

  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: () => apiGet<Channel[]>('/api/v1/channels'),
    enabled: Boolean(sessionQuery.data?.user),
  });

  const currentChannel = useMemo(
    () =>
      channelsQuery.data?.find((channel) => channel.id === selectedChannelId) ??
      channelsQuery.data?.find((channel) => channel.type === 'text') ??
      null,
    [channelsQuery.data, selectedChannelId],
  );

  const messagesQuery = useQuery({
    queryKey: ['messages', currentChannel?.id],
    queryFn: () => apiGet<Message[]>(`/api/v1/channels/${currentChannel?.id}/messages?limit=100`),
    enabled: Boolean(sessionQuery.data?.user && currentChannel?.id),
  });

  const membersQuery = useQuery({
    queryKey: ['members'],
    queryFn: () => apiGet<MemberPayload[]>('/api/v1/members'),
    enabled: Boolean(sessionQuery.data?.user),
    refetchInterval: 12_000,
  });

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => apiGet<RolePayload[]>('/api/v1/roles'),
    enabled: Boolean(sessionQuery.data?.user),
  });

  const voiceStateQuery = useQuery({
    queryKey: ['voice-state'],
    queryFn: () => apiGet<VoiceState[]>('/api/v1/voice/state'),
    enabled: Boolean(sessionQuery.data?.user),
    refetchInterval: 3_000,
  });

  useGateway(Boolean(sessionQuery.data?.user), useCallback((event) => {
    if (
      event.type === 'MESSAGE_CREATE' ||
      event.type === 'MESSAGE_UPDATE' ||
      event.type === 'MESSAGE_DELETE' ||
      event.type === 'VOICE_STATE_UPDATE'
    ) {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    }

    if (event.type === 'PRESENCE_UPDATE') {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    }

    if (event.type === 'MOD_ACTION') {
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    }
  }, [queryClient]));

  const membersById = useMemo(() => {
    const map = new Map<string, SessionPayload['user'] | MemberPayload>();
    const currentUser = sessionQuery.data?.user;
    if (currentUser) {
      map.set(currentUser.id, currentUser);
    }

    for (const member of membersQuery.data ?? []) {
      map.set(member.id, member);
    }
    return map;
  }, [membersQuery.data, sessionQuery.data?.user]);

  const memberList = useMemo(() => {
    const currentUser = sessionQuery.data?.user;
    if (!currentUser) {
      return [] as Array<SessionPayload['user'] | MemberPayload>;
    }

    const deduped = new Map<string, SessionPayload['user'] | MemberPayload>();
    deduped.set(currentUser.id, currentUser);
    for (const member of membersQuery.data ?? []) {
      deduped.set(member.id, member);
    }

    return Array.from(deduped.values()).sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle),
    );
  }, [membersQuery.data, sessionQuery.data?.user]);

  const voiceStatesByChannelId = useMemo(() => {
    const map = new Map<string, VoiceState[]>();
    for (const voiceState of voiceStateQuery.data ?? []) {
      const list = map.get(voiceState.channelId);
      if (list) {
        list.push(voiceState);
      } else {
        map.set(voiceState.channelId, [voiceState]);
      }
    }
    return map;
  }, [voiceStateQuery.data]);

  const voicePresenceByUserId = useMemo(() => {
    const map = new Map<string, VoiceState>();
    for (const voiceState of voiceStateQuery.data ?? []) {
      map.set(voiceState.userId, voiceState);
    }
    return map;
  }, [voiceStateQuery.data]);

  const selfVoiceState = useMemo(() => {
    const currentUserId = sessionQuery.data?.user?.id;
    if (!currentUserId) {
      return null;
    }
    return currentUserId ? voicePresenceByUserId.get(currentUserId) ?? null : null;
  }, [sessionQuery.data?.user?.id, voicePresenceByUserId]);

  const connectedVoiceChannel = useMemo(() => {
    if (!selfVoiceState?.channelId) {
      return null;
    }
    return channelsQuery.data?.find((channel) => channel.id === selfVoiceState.channelId) ?? null;
  }, [channelsQuery.data, selfVoiceState?.channelId]);

  const selectedVoiceParticipants = useMemo(() => {
    if (currentChannel?.type !== 'voice') {
      return [] as VoiceState[];
    }
    return voiceStatesByChannelId.get(currentChannel.id) ?? [];
  }, [currentChannel?.id, currentChannel?.type, voiceStatesByChannelId]);

  const connectedVoiceParticipants = useMemo(() => {
    if (!selfVoiceState?.channelId) {
      return [] as VoiceState[];
    }
    return voiceStatesByChannelId.get(selfVoiceState.channelId) ?? [];
  }, [selfVoiceState?.channelId, voiceStatesByChannelId]);

  const currentPermissions = useMemo(() => {
    const roleIds = sessionQuery.data?.user?.roleIds ?? [];
    const roleMap = new Map((rolesQuery.data ?? []).map((role) => [role.id, role]));
    const granted = new Set<string>();
    for (const roleId of roleIds) {
      const role = roleMap.get(roleId);
      if (!role) {
        continue;
      }
      for (const permission of role.permissions) {
        granted.add(permission);
      }
    }
    return granted;
  }, [rolesQuery.data, sessionQuery.data?.user?.roleIds]);

  const canManageChannels =
    currentPermissions.has('ADMINISTRATOR') || currentPermissions.has('MANAGE_CHANNELS');
  const canModerateMembers =
    currentPermissions.has('ADMINISTRATOR') || currentPermissions.has('MODERATE_MEMBERS');
  const canManageServer =
    currentPermissions.has('ADMINISTRATOR') || currentPermissions.has('MANAGE_SERVER');

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };

    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!isGifModalOpen || gifTab !== 'gifs') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const normalized = gifSearchInput.trim();
      setGifSearchQuery(normalized.length > 0 ? normalized : 'Trending GIFs');
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [gifSearchInput, isGifModalOpen, gifTab]);

  useEffect(() => {
    if (!isGifModalOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsGifModalOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isGifModalOpen]);

  const sendMessageMutation = useMutation({
    mutationFn: async () => {
      if (!currentChannel?.id) {
        return;
      }
      await apiPost(`/api/v1/channels/${currentChannel.id}/messages`, {
        content: messageText,
        gifUrl,
        attachmentIds,
      });
    },
    onSuccess: async () => {
      setMessageText('');
      setGifUrl(undefined);
      setAttachmentIds([]);
      await queryClient.invalidateQueries({ queryKey: ['messages', currentChannel?.id] });
    },
  });

  const gifSearchQueryResult = useQuery({
    queryKey: ['gif-search', gifSearchQuery],
    queryFn: () =>
      apiGet<GifSearchResponse>(
        `/api/v1/media/gifs/search?q=${encodeURIComponent(gifSearchQuery)}&limit=${MAX_GIF_RESULTS}`,
      ),
    enabled: Boolean(sessionQuery.data?.user && isGifModalOpen && gifTab === 'gifs'),
    staleTime: 30_000,
    retry: false,
  });

  const gifTiles = useMemo(
    () =>
      (gifSearchQueryResult.data?.results ?? [])
        .slice(0, MAX_GIF_RESULTS)
        .map((result, index) => {
          const selectUrl = result.media_formats?.gif?.url;
          const previewUrl = result.media_formats?.tinygif?.url ?? selectUrl;
          if (!selectUrl || !previewUrl) {
            return null;
          }

          return {
            id: result.id ?? `${gifSearchQuery}-${index}`,
            selectUrl,
            previewUrl,
            label: result.content_description ?? gifSearchQuery,
          };
        })
        .filter((item): item is { id: string; selectUrl: string; previewUrl: string; label: string } => Boolean(item)),
    [gifSearchQueryResult.data?.results, gifSearchQuery],
  );
  const gifProviderWarning = gifSearchQueryResult.data?.providerError?.message;

  const joinVoiceMutation = useMutation({
    mutationFn: (channelId: string) => {
      if (!channelId) {
        return Promise.resolve();
      }
      return apiPost(`/api/v1/voice/channels/${channelId}/join`, {
        muted: selfVoiceState?.muted ?? false,
        deafened: selfVoiceState?.deafened ?? false,
        pushToTalk: selfVoiceState?.pushToTalk ?? true,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    },
  });

  const leaveVoiceMutation = useMutation({
    mutationFn: () => {
      const channelId = selfVoiceState?.channelId ?? (currentChannel?.type === 'voice' ? currentChannel.id : null);
      if (!channelId) {
        return Promise.resolve();
      }
      return apiPost(`/api/v1/voice/channels/${channelId}/leave`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    },
  });

  const patchVoiceStateMutation = useMutation({
    mutationFn: (input: Partial<Pick<VoiceState, 'muted' | 'deafened' | 'pushToTalk' | 'speaking'>>) =>
      apiPatch('/api/v1/voice/state', input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    },
  });

  const handleRenameChannel = useCallback(async (channel: Channel) => {
    const nextName = window.prompt('Rename channel', channel.name)?.trim();
    if (!nextName || nextName === channel.name) {
      return;
    }

    await apiPatch(`/api/v1/channels/${channel.id}`, {
      name: nextName,
    });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [queryClient]);

  const handleDeleteChannel = useCallback(async (channel: Channel) => {
    const confirmed = window.confirm(`Delete "${channel.name}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    await apiDelete(`/api/v1/channels/${channel.id}`);
    if (selectedChannelId === channel.id) {
      setSelectedChannelId(null);
    }
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
    await queryClient.invalidateQueries({ queryKey: ['messages'] });
    await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
  }, [queryClient, selectedChannelId]);

  const handleToggleChannelLock = useCallback(async (channel: Channel) => {
    await apiPatch(`/api/v1/channels/${channel.id}/moderation`, {
      locked: !channel.locked,
      slowmodeSeconds: channel.slowmodeSeconds,
    });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [queryClient]);

  const handleMemberAction = useCallback(async (
    memberId: string,
    type: 'ban' | 'mute' | 'timeout' | 'kick' | 'warn',
    reason: string,
    timeoutMinutes?: number,
  ) => {
    const expiresAt =
      type === 'timeout' && timeoutMinutes
        ? new Date(Date.now() + timeoutMinutes * 60_000).toISOString()
        : undefined;

    await apiPost('/api/v1/moderation/actions', {
      targetUserId: memberId,
      type,
      reason,
      expiresAt,
    });
    await queryClient.invalidateQueries({ queryKey: ['members'] });
    await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
  }, [queryClient]);

  const runContextAction = useCallback(async (
    action:
      | 'open_server_settings'
      | 'rename_channel'
      | 'delete_channel'
      | 'toggle_channel_lock'
      | 'warn_user'
      | 'timeout_user'
      | 'mute_user'
      | 'kick_user'
      | 'ban_user',
  ) => {
    if (!contextMenu) {
      return;
    }

    try {
      if (contextMenu.kind === 'server') {
        if (!canManageServer) {
          setContextMenu(null);
          return;
        }
        if (action === 'open_server_settings') {
          setIsServerSettingsOpen(true);
        }
      }

      if (contextMenu.kind === 'channel') {
        if (!canManageChannels) {
          setContextMenu(null);
          return;
        }
        if (action === 'rename_channel') {
          await handleRenameChannel(contextMenu.channel);
        }
        if (action === 'delete_channel') {
          await handleDeleteChannel(contextMenu.channel);
        }
        if (action === 'toggle_channel_lock') {
          await handleToggleChannelLock(contextMenu.channel);
        }
      }

      if (contextMenu.kind === 'member') {
        if (!canModerateMembers) {
          setContextMenu(null);
          return;
        }
        const targetId = contextMenu.member.id;
        if (action === 'warn_user') {
          await handleMemberAction(targetId, 'warn', 'Server warning');
        }
        if (action === 'timeout_user') {
          await handleMemberAction(targetId, 'timeout', 'Timed out by admin', 10);
        }
        if (action === 'mute_user') {
          await handleMemberAction(targetId, 'mute', 'Muted by admin');
        }
        if (action === 'kick_user') {
          await handleMemberAction(targetId, 'kick', 'Removed by admin');
        }
        if (action === 'ban_user') {
          await handleMemberAction(targetId, 'ban', 'Banned by admin');
        }
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setContextMenu(null);
    }
  }, [canManageChannels, canManageServer, canModerateMembers, contextMenu, handleDeleteChannel, handleMemberAction, handleRenameChannel, handleToggleChannelLock]);

  const connectedVoiceChannelId = selfVoiceState?.channelId ?? null;

  const handleSelectChannel = useCallback((channel: Channel) => {
    setSelectedChannelId(channel.id);
    if (channel.type !== 'voice') {
      return;
    }
    if (connectedVoiceChannelId === channel.id || joinVoiceMutation.isPending) {
      return;
    }
    joinVoiceMutation.mutate(channel.id);
  }, [connectedVoiceChannelId, joinVoiceMutation]);

  const updateVoiceState = useCallback((input: Partial<Pick<VoiceState, 'muted' | 'deafened' | 'pushToTalk' | 'speaking'>>) => {
    if (!selfVoiceState) {
      return;
    }
    patchVoiceStateMutation.mutate(input);
  }, [patchVoiceStateMutation, selfVoiceState]);

  const setSpeakingState = useCallback((speaking: boolean) => {
    if (!selfVoiceState || !selfVoiceState.pushToTalk || selfVoiceState.deafened || selfVoiceState.muted) {
      return;
    }
    if (selfVoiceState.speaking === speaking) {
      return;
    }
    updateVoiceState({ speaking });
  }, [selfVoiceState, updateVoiceState]);

  if (setupQuery.isLoading || isExchangingAuth) {
    return <div className="loading-screen">Booting Current…</div>;
  }

  if (!setupQuery.data?.configured) {
    if (sessionQuery.isLoading) {
      return <div className="loading-screen">Booting Current…</div>;
    }

    if (!sessionQuery.data?.user) {
      return (
        <AuthScreen
          title="Sign In To Create Your Server"
          subtitle="Current assigns owner/admin permissions to the account that creates the server."
        />
      );
    }

    return (
      <SetupWizard
        owner={sessionQuery.data.user}
        onConfigured={() => {
          void setupQuery.refetch();
          void sessionQuery.refetch();
        }}
      />
    );
  }

  if (sessionQuery.isError || !sessionQuery.data?.user) {
    return <AuthScreen />;
  }

  const currentUser = sessionQuery.data.user;

  return (
    <div className="shell">
      <aside className="server-rail">
        <div
          className="brand-pill"
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              kind: 'server',
              x: event.clientX,
              y: event.clientY,
            });
          }}
          title="Right click for server options"
        >
          CU
        </div>
        <div className="server-name">{sessionQuery.data.server.name}</div>
        <button
          className="action-button"
          onClick={() => {
            void apiPost('/api/v1/auth/logout').then(() => window.location.reload());
          }}
        >
          Log out
        </button>
      </aside>

      <aside className="channels-pane">
        <header>
          <h2>Channels</h2>
          <button
            disabled={!canManageChannels}
            onClick={() => {
              if (!canManageChannels) {
                return;
              }
              void apiPost('/api/v1/channels', {
                name: `text-${Math.floor(Math.random() * 1000)}`,
                type: 'text',
              }).then(() => queryClient.invalidateQueries({ queryKey: ['channels'] }));
            }}
          >
            +
          </button>
        </header>

        <div className="channel-list">
          {(channelsQuery.data ?? []).map((channel) => {
            const channelVoiceStates = channel.type === 'voice' ? voiceStatesByChannelId.get(channel.id) ?? [] : [];
            const connectedHere = connectedVoiceChannelId === channel.id;
            const showVoiceRoster = channel.type === 'voice' && (currentChannel?.id === channel.id || connectedHere);
            return (
              <div key={channel.id} className="channel-entry">
                <button
                  className={`channel-item ${currentChannel?.id === channel.id ? 'active' : ''}`}
                  onClick={() => handleSelectChannel(channel)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      kind: 'channel',
                      x: event.clientX,
                      y: event.clientY,
                      channel,
                    });
                  }}
                >
                  <span className="channel-leading">{channel.type === 'voice' ? '◉' : '#'}</span>
                  <span className="channel-label">{channel.name}</span>
                  {channel.type === 'voice' && channelVoiceStates.length > 0 && (
                    <span className="channel-voice-count">{channelVoiceStates.length}</span>
                  )}
                  {connectedHere && <span className="channel-live-indicator" aria-hidden />}
                </button>
                {showVoiceRoster && channelVoiceStates.length > 0 && (
                  <ul className="voice-channel-roster">
                    {channelVoiceStates.map((voiceState) => {
                      const participant = membersById.get(voiceState.userId);
                      const participantName = participant?.displayName ?? voiceState.userId;
                      return (
                        <li
                          key={voiceState.userId}
                          className={`voice-channel-member ${voiceState.speaking ? 'speaking' : ''}`}
                        >
                          <Avatar src={participant?.avatarUrl} name={participantName} size="sm" />
                          <span>{participantName}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        <section className={`voice-box ${selfVoiceState ? 'connected' : ''}`}>
          <div className="voice-user">
            <Avatar src={currentUser.avatarUrl} name={currentUser.displayName} size="md" />
            <div>
              <strong>{currentUser.displayName}</strong>
              <small>@{currentUser.handle}</small>
            </div>
          </div>

          <div className="voice-connection-row">
            <div className="voice-connection-copy">
              <strong>{selfVoiceState ? 'Voice Connected' : 'Not In Voice'}</strong>
              <small>
                {selfVoiceState
                  ? `${connectedVoiceChannel ? `#${connectedVoiceChannel.name}` : 'Voice channel'} · ${connectedVoiceParticipants.length} participant${connectedVoiceParticipants.length === 1 ? '' : 's'}`
                  : currentChannel?.type === 'voice'
                    ? `Ready to join #${currentChannel.name}`
                    : 'Pick a voice channel to connect'}
              </small>
            </div>
            {!selfVoiceState && (
              <button
                onClick={() => {
                  if (currentChannel?.type !== 'voice') {
                    return;
                  }
                  joinVoiceMutation.mutate(currentChannel.id);
                }}
                disabled={currentChannel?.type !== 'voice' || joinVoiceMutation.isPending}
              >
                Join
              </button>
            )}
          </div>

          <div className="voice-controls">
            <button
              className={selfVoiceState?.muted ? 'active' : ''}
              onClick={() => updateVoiceState({ muted: !selfVoiceState?.muted })}
              disabled={!selfVoiceState}
            >
              {selfVoiceState?.muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              className={selfVoiceState?.deafened ? 'active' : ''}
              onClick={() => updateVoiceState({ deafened: !selfVoiceState?.deafened })}
              disabled={!selfVoiceState}
            >
              {selfVoiceState?.deafened ? 'Undeafen' : 'Deafen'}
            </button>
            <button
              className={selfVoiceState?.pushToTalk ? 'active' : ''}
              onClick={() => updateVoiceState({ pushToTalk: !selfVoiceState?.pushToTalk })}
              disabled={!selfVoiceState}
            >
              PTT
            </button>
          </div>

          {selfVoiceState?.pushToTalk && (
            <button
              className={`voice-ptt ${selfVoiceState.speaking ? 'active' : ''}`}
              onMouseDown={() => setSpeakingState(true)}
              onMouseUp={() => setSpeakingState(false)}
              onMouseLeave={() => setSpeakingState(false)}
              onTouchStart={() => setSpeakingState(true)}
              onTouchEnd={() => setSpeakingState(false)}
            >
              Hold To Talk
            </button>
          )}

          {selfVoiceState && (
            <button
              className="voice-disconnect voice-disconnect-bottom"
              onClick={() => leaveVoiceMutation.mutate()}
              disabled={leaveVoiceMutation.isPending}
            >
              Leave Voice
            </button>
          )}
        </section>
      </aside>

      <main className="chat-pane">
        <header className="chat-header">
          <h1>{currentChannel ? `${currentChannel.type === 'voice' ? '◉' : '#'} ${currentChannel.name}` : 'Select a channel'}</h1>
          {currentChannel?.type === 'voice' && (
            <div className="header-actions">
              <small>{selectedVoiceParticipants.length} connected</small>
              {connectedVoiceChannelId === currentChannel.id ? (
                <button onClick={() => leaveVoiceMutation.mutate()} disabled={leaveVoiceMutation.isPending}>
                  Disconnect
                </button>
              ) : (
                <button onClick={() => joinVoiceMutation.mutate(currentChannel.id)} disabled={joinVoiceMutation.isPending}>
                  Join Voice
                </button>
              )}
            </div>
          )}
        </header>

        {currentChannel?.type === 'voice' ? (
          <section className="voice-room">
            <header className="voice-room-header">
              <h3>Voice Participants</h3>
              <small>{selectedVoiceParticipants.length} online</small>
            </header>
            {selectedVoiceParticipants.length === 0 ? (
              <div className="voice-room-empty">No one is in this channel yet.</div>
            ) : (
              <ul className="voice-room-list">
                {selectedVoiceParticipants.map((voiceState) => {
                  const participant = membersById.get(voiceState.userId);
                  const participantName = participant?.displayName ?? voiceState.userId;
                  return (
                    <li key={voiceState.userId} className={`voice-room-member ${voiceState.speaking ? 'speaking' : ''}`}>
                      <div className="voice-room-member-main">
                        <Avatar src={participant?.avatarUrl} name={participantName} size="md" />
                        <div>
                          <strong>{participantName}</strong>
                          <small>{participant?.handle ? `@${participant.handle}` : voiceState.userId}</small>
                        </div>
                      </div>
                      <div className="voice-room-state">
                        {voiceState.deafened && <span>Deafened</span>}
                        {!voiceState.deafened && voiceState.muted && <span>Muted</span>}
                        {voiceState.speaking && <span className="speaking">Speaking</span>}
                        {!voiceState.speaking && !voiceState.muted && !voiceState.deafened && <span>Listening</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : (
          <>
            <section className="messages-list">
              {(messagesQuery.data ?? []).map((message) => {
                const author = membersById.get(message.authorId);
                const isOwnMessage = message.authorId === currentUser.id;
                return (
                  <article
                    key={message.id}
                    className={`message-row ${isOwnMessage ? 'own' : 'other'}`}
                  >
                    <Avatar src={author?.avatarUrl} name={author?.displayName ?? message.authorId} size="md" />
                    <div className={`message-body ${isOwnMessage ? 'own' : 'other'}`}>
                      <div className="message-meta">
                        <strong>{isOwnMessage ? 'You' : (author?.displayName ?? message.authorId)}</strong>
                        <small>{author?.handle ? `@${author.handle}` : message.authorId}</small>
                      </div>
                      <p>{message.content}</p>
                      {message.gifUrl && <img src={message.gifUrl} alt="gif" className="gif-preview" />}
                      {(message.attachments ?? []).length > 0 && (
                        <ul>
                          {message.attachments?.map((attachment) => (
                            <li key={attachment.id}>
                              <a href={`/api/v1/media/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                                {attachment.fileName}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>

            <footer className="composer">
              <div className="composer-inline">
                <label className="inline-icon attach" title="Attach file">
                  +
                  <input
                    type="file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) {
                        return;
                      }
                      void uploadAttachment(file).then((attachment) => {
                        setAttachmentIds((prev) => [...prev, attachment.id]);
                      });
                    }}
                  />
                </label>
                <textarea
                  className="composer-input"
                  rows={1}
                  value={messageText}
                  onChange={(event) => setMessageText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && currentChannel && messageText.trim()) {
                      event.preventDefault();
                      sendMessageMutation.mutate();
                    }
                  }}
                  placeholder={currentChannel ? `Message #${currentChannel.name}` : 'Message current channel'}
                />
                <div className="inline-actions">
                  <button
                    className="inline-icon"
                    onClick={() => {
                      setGifTab('gifs');
                      setIsGifModalOpen(true);
                    }}
                    title="Open GIF picker"
                  >
                    GIF
                  </button>
                  <button
                    className="inline-icon"
                    onClick={() => {
                      setGifTab('stickers');
                      setIsGifModalOpen(true);
                    }}
                    title="Open Stickers"
                  >
                    ◍
                  </button>
                  <button
                    className="inline-icon"
                    onClick={() => {
                      setGifTab('emoji');
                      setIsGifModalOpen(true);
                    }}
                    title="Open Emoji"
                  >
                    ☺
                  </button>
                </div>
              </div>
              {(gifUrl || attachmentIds.length > 0) && (
                <small>
                  Draft media: {gifUrl ? 'GIF selected' : ''} {attachmentIds.length > 0 ? `${attachmentIds.length} attachments` : ''}
                </small>
              )}
            </footer>
          </>
        )}
      </main>

      <aside className="members-pane">
        <header>
          <h2>Members</h2>
          <small>{memberList.length}</small>
        </header>
        <ul className="member-list">
          {memberList.map((member) => {
            const inVoice = voicePresenceByUserId.has(member.id);
            const speaking = voicePresenceByUserId.get(member.id)?.speaking ?? false;
            const isSelf = member.id === currentUser.id;
            return (
              <li
                key={member.id}
                className="member-item"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    kind: 'member',
                    x: event.clientX,
                    y: event.clientY,
                    member,
                  });
                }}
              >
                <div className="member-main">
                  <Avatar src={member.avatarUrl} name={member.displayName} size="sm" />
                  <div className="member-text">
                    <strong>{member.displayName}{isSelf ? ' (You)' : ''}</strong>
                    <small>@{member.handle}</small>
                  </div>
                </div>
                <span className={`member-state ${speaking ? 'speaking' : inVoice ? 'in-voice' : 'idle'}`} />
              </li>
            );
          })}
        </ul>
      </aside>
      {isGifModalOpen && (
        <div className="gif-modal-backdrop" onClick={() => setIsGifModalOpen(false)}>
          <section className="gif-modal" onClick={(event) => event.stopPropagation()}>
            <header className="gif-modal-top">
              <div className="gif-tabs">
                <button
                  className={gifTab === 'gifs' ? 'active' : ''}
                  onClick={() => setGifTab('gifs')}
                >
                  GIFs
                </button>
                <button
                  className={gifTab === 'stickers' ? 'active' : ''}
                  onClick={() => setGifTab('stickers')}
                >
                  Stickers
                </button>
                <button
                  className={gifTab === 'emoji' ? 'active' : ''}
                  onClick={() => setGifTab('emoji')}
                >
                  Emoji
                </button>
              </div>
              <button className="gif-close" onClick={() => setIsGifModalOpen(false)}>
                ×
              </button>
            </header>

            <input
              className="gif-search-input"
              value={gifSearchInput}
              onChange={(event) => setGifSearchInput(event.target.value)}
              placeholder={gifTab === 'gifs' ? 'Search GIFs' : 'Coming soon in Current'}
              disabled={gifTab !== 'gifs'}
            />

            {gifTab !== 'gifs' ? (
              <div className="gif-empty-state">
                <h4>{gifTab === 'stickers' ? 'Stickers are coming soon' : 'Emoji browser is coming soon'}</h4>
                <p>GIF support is live now. Use the GIF tab to insert animated media.</p>
              </div>
            ) : (
              <>
                <div className="gif-topic-grid">
                  {GIF_QUICK_TOPICS.map((topic) => (
                    <button
                      key={topic}
                      className="gif-topic-card"
                      onClick={() => {
                        setGifSearchInput(topic);
                        setGifSearchQuery(topic);
                      }}
                    >
                      {topic}
                    </button>
                  ))}
                </div>
                <div className="gif-results-grid">
                  {gifSearchQueryResult.isLoading && <p>Loading GIFs…</p>}
                  {gifSearchQueryResult.isError && <p>Could not load GIFs right now.</p>}
                  {!gifSearchQueryResult.isLoading && !gifSearchQueryResult.isError && gifProviderWarning && (
                    <p className="gif-provider-warning">{gifProviderWarning}</p>
                  )}
                  {!gifSearchQueryResult.isLoading && !gifSearchQueryResult.isError && gifTiles.length === 0 && (
                    <p>No GIFs found for this search.</p>
                  )}
                  {gifTiles.map((tile) => (
                    <button
                      key={tile.id}
                      className="gif-result-card"
                      onClick={() => {
                        setGifUrl(tile.selectUrl);
                        setIsGifModalOpen(false);
                      }}
                    >
                      <img src={tile.previewUrl} alt={tile.label} />
                      <span>{tile.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}
      <ServerSettingsModal
        open={isServerSettingsOpen}
        onClose={() => setIsServerSettingsOpen(false)}
        canManageServer={canManageServer}
        members={memberList.map((member) => ({
          id: member.id,
          handle: member.handle,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
        }))}
      />
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === 'server' && (
            <>
              <button disabled={!canManageServer} onClick={() => void runContextAction('open_server_settings')}>
                Server Settings
              </button>
              {!canManageServer && <small className="context-note">Need MANAGE_SERVER permission.</small>}
            </>
          )}
          {contextMenu.kind === 'channel' && (
            <>
              <button disabled={!canManageChannels} onClick={() => void runContextAction('rename_channel')}>
                Edit Channel
              </button>
              <button disabled={!canManageChannels} onClick={() => void runContextAction('toggle_channel_lock')}>
                {contextMenu.channel.locked ? 'Unlock Channel' : 'Lock Channel'}
              </button>
              <button className="danger" disabled={!canManageChannels} onClick={() => void runContextAction('delete_channel')}>
                Delete Channel
              </button>
              {!canManageChannels && <small className="context-note">Need MANAGE_CHANNELS permission.</small>}
            </>
          )}
          {contextMenu.kind === 'member' && (
            <>
              <button
                disabled={!canModerateMembers || contextMenu.member.id === currentUser.id}
                onClick={() => void runContextAction('warn_user')}
              >
                Warn User
              </button>
              <button
                disabled={!canModerateMembers || contextMenu.member.id === currentUser.id}
                onClick={() => void runContextAction('timeout_user')}
              >
                Timeout 10m
              </button>
              <button
                disabled={!canModerateMembers || contextMenu.member.id === currentUser.id}
                onClick={() => void runContextAction('mute_user')}
              >
                Mute User
              </button>
              <button
                disabled={!canModerateMembers || contextMenu.member.id === currentUser.id}
                onClick={() => void runContextAction('kick_user')}
              >
                Kick User
              </button>
              <button
                className="danger"
                disabled={!canModerateMembers || contextMenu.member.id === currentUser.id}
                onClick={() => void runContextAction('ban_user')}
              >
                Ban User
              </button>
              {!canModerateMembers && <small className="context-note">Need MODERATE_MEMBERS permission.</small>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SetupWizard({
  owner,
  onConfigured,
}: {
  owner: SessionPayload['user'];
  onConfigured: () => void;
}) {
  const [serverName, setServerName] = useState('Current Community');
  const [slug, setSlug] = useState('current-community');
  const [publicUrl, setPublicUrl] = useState(() => inferDefaultServerPublicUrl());
  const [registrationMode, setRegistrationMode] = useState<'invite_only' | 'open_signup' | 'manual_approval'>('invite_only');

  const setupMutation = useMutation({
    mutationFn: () =>
      apiPost('/api/v1/setup/bootstrap', {
        serverName,
        slug,
        publicUrl,
        registrationMode,
      }),
    onSuccess: () => onConfigured(),
  });

  return (
    <div className="wizard-wrap">
      <div className="wizard-card">
        <h1>Set Up Current</h1>
        <p>Launch your local-first community in under a minute.</p>
        <small>
          Owner account: <strong>{owner.displayName}</strong> (@{owner.handle})
        </small>
        <label>
          Server name
          <input value={serverName} onChange={(event) => setServerName(event.target.value)} />
        </label>
        <label>
          Slug
          <input value={slug} onChange={(event) => setSlug(event.target.value)} />
        </label>
        <label>
          Public URL
          <input value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} />
        </label>
        <label>
          Registration mode
          <select
            value={registrationMode}
            onChange={(event) =>
              setRegistrationMode(event.target.value as 'invite_only' | 'open_signup' | 'manual_approval')
            }
          >
            <option value="invite_only">Invite-only</option>
            <option value="open_signup">Open signup</option>
            <option value="manual_approval">Manual approval</option>
          </select>
        </label>
        <button onClick={() => setupMutation.mutate()} disabled={setupMutation.isPending}>
          Initialize Server
        </button>
      </div>
    </div>
  );
}

function inferDefaultServerPublicUrl(): string {
  const base = new URL(window.location.href);
  base.protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  base.port = '8080';
  base.pathname = '';
  base.search = '';
  base.hash = '';
  return base.toString().replace(/\/$/, '');
}

function AuthScreen({
  title = 'Sign In With Bluesky',
  subtitle = 'Current uses atproto OAuth for identity. Your server still hosts all chat and voice data locally.',
}: {
  title?: string;
  subtitle?: string;
}) {
  const [blueskyHandle, setBlueskyHandle] = useState('');
  const [devHandle, setDevHandle] = useState('local.dev@current');
  const [lanHandoff, setLanHandoff] = useState<OAuthLanHandoffPayload | null>(null);
  const normalizedIdentity = blueskyHandle.trim();
  const oauthIdentity = normalizedIdentity.length > 0 ? normalizedIdentity : 'bsky.social';
  const looksLikeEmail =
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedIdentity) &&
    !normalizedIdentity.startsWith('@') &&
    !normalizedIdentity.startsWith('did:');
  const canSubmitOAuth = !looksLikeEmail && oauthIdentity.length >= 3;

  const oauthMutation = useMutation({
    mutationFn: () => {
      const params = new URLSearchParams({
        handle: oauthIdentity,
        returnTo: window.location.origin + window.location.pathname,
      });
      return apiGet<OAuthStartPayload>(`/api/v1/auth/oauth/start?${params.toString()}`);
    },
    onSuccess: (data) => {
      if (data.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
        return;
      }
      if (data.lanHandoff) {
        setLanHandoff(data.lanHandoff);
      }
    },
  });

  const lanHandoffStatusQuery = useQuery({
    queryKey: ['auth', 'lan-handoff', lanHandoff?.handoffId],
    queryFn: () => apiGet<OAuthLanHandoffStatusPayload>(`/api/v1/auth/lan/handoffs/${lanHandoff?.handoffId}`),
    enabled: Boolean(lanHandoff?.handoffId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!lanHandoff || status === 'ready' || status === 'claimed' || status === 'expired') {
        return false;
      }
      return 2_000;
    },
  });

  const claimLanHandoffMutation = useMutation({
    mutationFn: (handoffId: string) =>
      apiPost<{ ticket: string }>(`/api/v1/auth/lan/handoffs/${handoffId}/claim`),
    onSuccess: async ({ ticket }) => {
      await apiPost<void>('/api/v1/auth/exchange', { ticket });
      window.location.reload();
    },
  });

  useEffect(() => {
    if (!lanHandoff?.handoffId) {
      return;
    }
    if (lanHandoffStatusQuery.data?.status !== 'ready') {
      return;
    }
    if (claimLanHandoffMutation.isPending || claimLanHandoffMutation.isSuccess) {
      return;
    }
    claimLanHandoffMutation.mutate(lanHandoff.handoffId);
  }, [
    claimLanHandoffMutation,
    lanHandoff?.handoffId,
    lanHandoffStatusQuery.data?.status,
  ]);

  const devLoginMutation = useMutation({
    mutationFn: () => apiPost<{ user: SessionPayload['user'] }>('/api/v1/auth/dev-login', { handle: devHandle }),
    onSuccess: () => {
      window.location.reload();
    },
  });

  const authError =
    (oauthMutation.error instanceof Error ? oauthMutation.error.message : undefined) ??
    (claimLanHandoffMutation.error instanceof Error ? claimLanHandoffMutation.error.message : undefined) ??
    (devLoginMutation.error instanceof Error ? devLoginMutation.error.message : undefined);

  return (
    <div className="wizard-wrap">
      <div className="wizard-card">
        <h1>{title}</h1>
        <p>{subtitle}</p>
        <label>
          Bluesky handle
          <input
            value={blueskyHandle}
            onChange={(event) => setBlueskyHandle(event.target.value)}
            placeholder="krouss.net or you.bsky.social"
          />
        </label>
        <small>Custom domains work here. Example: `krouss.net`.</small>
        {looksLikeEmail && <small className="auth-error">Use your Bluesky handle, not your email address.</small>}
        <div className="auth-actions">
          <button onClick={() => oauthMutation.mutate()} disabled={oauthMutation.isPending || !canSubmitOAuth}>
            Continue with Bluesky
          </button>
          <button onClick={() => devLoginMutation.mutate()} disabled={devLoginMutation.isPending}>
            Local Dev Sign-In
          </button>
        </div>
        {lanHandoff && (
          <div className="auth-lan-handoff">
            <strong>LAN OAuth Handoff</strong>
            <p>{lanHandoff.message ?? 'Complete Bluesky sign-in on the server host machine to finish login here.'}</p>
            <label>
              Open this on the host machine
              <input readOnly value={lanHandoff.hostAuthUrl} />
            </label>
            <div className="auth-actions">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(lanHandoff.hostAuthUrl);
                }}
              >
                Copy Host Link
              </button>
            </div>
            <small>
              Status:{' '}
              {claimLanHandoffMutation.isPending
                ? 'Exchanging session...'
                : lanHandoffStatusQuery.data?.status === 'ready'
                  ? 'Host sign-in complete. Finalizing...'
                  : lanHandoffStatusQuery.data?.status === 'expired'
                    ? 'Expired. Start sign-in again.'
                    : lanHandoffStatusQuery.data?.status === 'claimed'
                      ? 'Session claimed. Refreshing...'
                      : 'Waiting for host sign-in...'}
            </small>
          </div>
        )}
        <label>
          Dev handle (local testing only)
          <input value={devHandle} onChange={(event) => setDevHandle(event.target.value)} />
        </label>
        {authError && <small className="auth-error">{authError}</small>}
      </div>
    </div>
  );
}

function Avatar({
  src,
  name,
  size,
}: {
  src?: string;
  name: string;
  size: 'sm' | 'md';
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || '?';

  const className = `avatar avatar-${size}`;
  if (src) {
    return <img src={src} alt={name} className={className} />;
  }

  return (
    <div className={className} aria-hidden>
      {initials}
    </div>
  );
}
