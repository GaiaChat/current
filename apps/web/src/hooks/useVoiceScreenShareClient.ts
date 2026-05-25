import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  VoiceScreenShare,
  VoiceScreenShareSettings,
  VoiceScreenShareSignal,
} from '@current/types';
import { apiPost } from '../lib/api';
import type { GatewayEnvelope } from './useGateway';
import type { VoiceSessionInfo } from './useVoiceClient';

type ScreenShareStatus =
  | 'idle'
  | 'requesting_screen'
  | 'starting'
  | 'sharing'
  | 'permission_denied'
  | 'unsupported'
  | 'failed';

interface ScreenShareStartResponse {
  share: VoiceScreenShare;
  viewers: string[];
  settings: VoiceScreenShareSettings;
}

interface RemoteScreenShareEntry {
  share: VoiceScreenShare;
  stream: MediaStream | null;
}

export interface RemoteScreenShare {
  share: VoiceScreenShare;
  stream: MediaStream | null;
}

export interface LocalScreenShare {
  share: VoiceScreenShare;
  stream: MediaStream;
}

function isScreenSharePermissionDenied(error: unknown): boolean {
  return error instanceof DOMException && (
    error.name === 'NotAllowedError' ||
    error.name === 'PermissionDeniedError' ||
    error.name === 'SecurityError' ||
    error.name === 'AbortError'
  );
}

function createDisplayMediaOptions(settings: VoiceScreenShareSettings): DisplayMediaStreamOptions {
  return {
    video: {
      width: { max: settings.maxWidth },
      height: { max: settings.maxHeight },
      frameRate: { max: settings.maxFrameRate },
    },
    audio: false,
  };
}

function getIceCandidateInit(candidate: RTCIceCandidate): RTCIceCandidateInit {
  return typeof candidate.toJSON === 'function'
    ? candidate.toJSON()
    : {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment ?? undefined,
      };
}

async function applyCaptureSettings(
  stream: MediaStream,
  settings: VoiceScreenShareSettings | VoiceScreenShare['constraints'],
): Promise<void> {
  await Promise.all(stream.getVideoTracks().map(async (track) => {
    track.contentHint = 'detail';
    await track.applyConstraints({
      width: { max: settings.maxWidth },
      height: { max: settings.maxHeight },
      frameRate: { max: settings.maxFrameRate },
    }).catch(() => undefined);
  }));
}

async function applySenderBitrate(sender: RTCRtpSender, maxBitrateKbps: number): Promise<void> {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  parameters.encodings = parameters.encodings.map((encoding) => ({
    ...encoding,
    maxBitrate: maxBitrateKbps * 1000,
  }));
  await sender.setParameters(parameters).catch(() => undefined);
}

export function useVoiceScreenShareClient({
  currentUserId,
  voiceSession,
}: {
  currentUserId?: string;
  voiceSession: VoiceSessionInfo | null;
}) {
  const [status, setStatus] = useState<ScreenShareStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [localShare, setLocalShare] = useState<LocalScreenShare | null>(null);
  const [remoteShares, setRemoteShares] = useState<RemoteScreenShare[]>([]);

  const sessionRef = useRef<VoiceSessionInfo | null>(voiceSession);
  const currentUserIdRef = useRef<string | undefined>(currentUserId);
  const localShareRef = useRef<LocalScreenShare | null>(null);
  const senderPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const viewerPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteSharesRef = useRef<Map<string, RemoteScreenShareEntry>>(new Map());
  const watchedSharesRef = useRef<Set<string>>(new Set());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  useEffect(() => {
    sessionRef.current = voiceSession;
  }, [voiceSession]);

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  const refreshRemoteShares = useCallback(() => {
    setRemoteShares([...remoteSharesRef.current.values()].map((entry) => ({
      share: entry.share,
      stream: entry.stream,
    })));
  }, []);

  const sendSignal = useCallback(async (
    shareId: string,
    targetUserId: string,
    signal: VoiceScreenShareSignal,
  ) => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    await apiPost<void>(`/api/v1/voice/screen-shares/${shareId}/signal`, {
      sessionId: session.sessionId,
      targetUserId,
      signal,
    });
  }, []);

  const flushPendingCandidates = useCallback(async (key: string, connection: RTCPeerConnection) => {
    if (!connection.remoteDescription) {
      return;
    }
    const candidates = pendingCandidatesRef.current.get(key) ?? [];
    pendingCandidatesRef.current.delete(key);
    for (const candidate of candidates) {
      await connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  const addRemoteCandidate = useCallback(async (
    key: string,
    connection: RTCPeerConnection | undefined,
    candidate: RTCIceCandidateInit,
  ) => {
    if (!connection) {
      const queued = pendingCandidatesRef.current.get(key) ?? [];
      queued.push(candidate);
      pendingCandidatesRef.current.set(key, queued);
      return;
    }
    if (!connection.remoteDescription) {
      const queued = pendingCandidatesRef.current.get(key) ?? [];
      queued.push(candidate);
      pendingCandidatesRef.current.set(key, queued);
      return;
    }
    await connection.addIceCandidate(candidate).catch(() => undefined);
  }, []);

  const closeSenderPeer = useCallback((targetUserId: string) => {
    const connection = senderPeersRef.current.get(targetUserId);
    senderPeersRef.current.delete(targetUserId);
    pendingCandidatesRef.current.delete(`sender:${targetUserId}`);
    connection?.close();
  }, []);

  const closeRemoteShare = useCallback((shareId: string, notifyOwner = false) => {
    const connection = viewerPeersRef.current.get(shareId);
    viewerPeersRef.current.delete(shareId);
    const entry = remoteSharesRef.current.get(shareId);
    remoteSharesRef.current.delete(shareId);
    watchedSharesRef.current.delete(shareId);
    pendingCandidatesRef.current.delete(`viewer:${shareId}`);
    if (notifyOwner && entry) {
      void sendSignal(shareId, entry.share.userId, { type: 'viewer-left' }).catch(() => undefined);
    }
    connection?.close();
    for (const track of entry?.stream?.getTracks() ?? []) {
      track.stop();
    }
    refreshRemoteShares();
  }, [refreshRemoteShares, sendSignal]);

  const cleanupLocalShare = useCallback((stopTracks: boolean) => {
    for (const targetUserId of [...senderPeersRef.current.keys()]) {
      closeSenderPeer(targetUserId);
    }
    const current = localShareRef.current;
    if (stopTracks) {
      for (const track of current?.stream.getTracks() ?? []) {
        track.stop();
      }
    }
    localShareRef.current = null;
    setLocalShare(null);
    setStatus('idle');
  }, [closeSenderPeer]);

  const stopSharing = useCallback(async () => {
    const session = sessionRef.current;
    const current = localShareRef.current;
    cleanupLocalShare(true);
    setError(null);
    if (session && current) {
      await apiPost<void>(`/api/v1/voice/screen-shares/${current.share.id}/stop`, {
        sessionId: session.sessionId,
      }).catch(() => undefined);
    }
  }, [cleanupLocalShare]);

  const createPeerConnection = useCallback((
    shareId: string,
    targetUserId: string,
    role: 'sender' | 'viewer',
  ) => {
    const session = sessionRef.current;
    const connection = new RTCPeerConnection({
      iceServers: session?.iceServers ?? [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        void sendSignal(shareId, targetUserId, {
          type: 'ice',
          candidate: getIceCandidateInit(event.candidate),
        }).catch(() => undefined);
      }
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        if (role === 'sender') {
          closeSenderPeer(targetUserId);
        } else {
          closeRemoteShare(shareId);
        }
      }
    };
    return connection;
  }, [closeRemoteShare, closeSenderPeer, sendSignal]);

  const ensureSenderConnection = useCallback(async (targetUserId: string) => {
    const current = localShareRef.current;
    if (!current || targetUserId === currentUserIdRef.current) {
      return;
    }
    const existing = senderPeersRef.current.get(targetUserId);
    if (existing && existing.connectionState !== 'closed') {
      return;
    }

    const connection = createPeerConnection(current.share.id, targetUserId, 'sender');
    senderPeersRef.current.set(targetUserId, connection);
    for (const track of current.stream.getTracks()) {
      const sender = connection.addTrack(track, current.stream);
      if (track.kind === 'video') {
        void applySenderBitrate(sender, current.share.constraints.maxBitrateKbps);
      }
    }
    const offer = await connection.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });
    await connection.setLocalDescription(offer);
    if (connection.localDescription) {
      await sendSignal(current.share.id, targetUserId, {
        type: 'offer',
        description: connection.localDescription.toJSON(),
      });
    }
  }, [createPeerConnection, sendSignal]);

  const watchShare = useCallback((share: VoiceScreenShare) => {
    const session = sessionRef.current;
    if (!session || share.channelId !== session.channelId || share.userId === currentUserIdRef.current) {
      return;
    }
    remoteSharesRef.current.set(share.id, {
      share,
      stream: remoteSharesRef.current.get(share.id)?.stream ?? null,
    });
    refreshRemoteShares();
    if (watchedSharesRef.current.has(share.id)) {
      return;
    }
    watchedSharesRef.current.add(share.id);
    void sendSignal(share.id, share.userId, { type: 'viewer-ready' }).catch(() => undefined);
  }, [refreshRemoteShares, sendSignal]);

  const handleOffer = useCallback(async (
    shareId: string,
    fromUserId: string,
    description: RTCSessionDescriptionInit,
  ) => {
    const entry = remoteSharesRef.current.get(shareId);
    if (!entry || entry.share.userId !== fromUserId) {
      return;
    }
    viewerPeersRef.current.get(shareId)?.close();
    const connection = createPeerConnection(shareId, fromUserId, 'viewer');
    viewerPeersRef.current.set(shareId, connection);
    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) {
        return;
      }
      remoteSharesRef.current.set(shareId, {
        share: entry.share,
        stream,
      });
      refreshRemoteShares();
    };
    await connection.setRemoteDescription(description);
    await flushPendingCandidates(`viewer:${shareId}`, connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (connection.localDescription) {
      await sendSignal(shareId, fromUserId, {
        type: 'answer',
        description: connection.localDescription.toJSON(),
      });
    }
  }, [createPeerConnection, flushPendingCandidates, refreshRemoteShares, sendSignal]);

  const handleGatewayEvent = useCallback((event: GatewayEnvelope) => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    if (event.type === 'VOICE_SCREEN_SHARE_STARTED') {
      const payload = event.payload as { screenShare?: VoiceScreenShare };
      if (payload.screenShare) {
        watchShare(payload.screenShare);
      }
      return;
    }

    if (event.type === 'VOICE_SCREEN_SHARE_STOPPED') {
      const payload = event.payload as { shareId?: string; userId?: string };
      if (!payload.shareId) {
        return;
      }
      if (localShareRef.current?.share.id === payload.shareId) {
        cleanupLocalShare(payload.userId !== currentUserIdRef.current);
      }
      closeRemoteShare(payload.shareId);
      return;
    }

    if (event.type === 'VOICE_STATE_UPDATE') {
      const payload = event.payload as {
        voiceState?: {
          userId?: string;
          channelId?: string | null;
        };
      };
      const voiceState = payload.voiceState;
      const currentShare = localShareRef.current?.share;
      if (
        voiceState?.userId &&
        currentShare &&
        voiceState.userId !== currentUserIdRef.current &&
        voiceState.channelId !== currentShare.channelId
      ) {
        closeSenderPeer(voiceState.userId);
      }
      return;
    }

    if (event.type !== 'VOICE_SCREEN_SHARE_SIGNAL') {
      return;
    }

    const payload = event.payload as {
      channelId?: string;
      shareId?: string;
      fromUserId?: string;
      targetUserId?: string;
      signal?: VoiceScreenShareSignal;
    };
    if (
      !payload.shareId ||
      !payload.fromUserId ||
      !payload.signal ||
      payload.channelId !== session.channelId ||
      payload.targetUserId !== currentUserIdRef.current
    ) {
      return;
    }

    if (payload.signal.type === 'viewer-ready') {
      void ensureSenderConnection(payload.fromUserId).catch((error) => {
        setError(error instanceof Error ? error.message : 'Could not connect screen share viewer.');
      });
      return;
    }

    if (payload.signal.type === 'viewer-left') {
      closeSenderPeer(payload.fromUserId);
      return;
    }

    if (payload.signal.type === 'offer') {
      void handleOffer(payload.shareId, payload.fromUserId, payload.signal.description).catch((error) => {
        setError(error instanceof Error ? error.message : 'Could not open screen share.');
      });
      return;
    }

    if (payload.signal.type === 'answer') {
      const connection = senderPeersRef.current.get(payload.fromUserId);
      if (connection) {
        void connection.setRemoteDescription(payload.signal.description)
          .then(() => flushPendingCandidates(`sender:${payload.fromUserId}`, connection))
          .catch(() => undefined);
      }
      return;
    }

    if (payload.signal.type === 'ice') {
      const isLocalOwner = localShareRef.current?.share.id === payload.shareId;
      const key = isLocalOwner ? `sender:${payload.fromUserId}` : `viewer:${payload.shareId}`;
      const connection = isLocalOwner
        ? senderPeersRef.current.get(payload.fromUserId)
        : viewerPeersRef.current.get(payload.shareId);
      void addRemoteCandidate(key, connection, payload.signal.candidate);
    }
  }, [
    addRemoteCandidate,
    cleanupLocalShare,
    closeRemoteShare,
    closeSenderPeer,
    ensureSenderConnection,
    flushPendingCandidates,
    handleOffer,
    watchShare,
  ]);

  const startSharing = useCallback(async () => {
    const session = sessionRef.current;
    const settings = session?.screenShare;
    if (!session || !currentUserIdRef.current) {
      throw new Error('Join a voice channel before sharing your screen.');
    }
    if (!settings?.enabled) {
      throw new Error('Screen sharing is disabled on this server.');
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus('unsupported');
      throw new Error('Screen sharing is not supported in this browser.');
    }

    setStatus('requesting_screen');
    setError(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(createDisplayMediaOptions(settings));
      await applyCaptureSettings(stream, settings);
      const [track] = stream.getVideoTracks();
      if (!track) {
        throw new Error('No screen video track was returned.');
      }

      setStatus('starting');
      const started = await apiPost<ScreenShareStartResponse>(
        `/api/v1/voice/channels/${session.channelId}/screen-shares`,
        { sessionId: session.sessionId },
      );
      await applyCaptureSettings(stream, started.settings);
      const share: LocalScreenShare = {
        share: started.share,
        stream,
      };
      localShareRef.current = share;
      setLocalShare(share);
      setStatus('sharing');
      track.addEventListener('ended', () => {
        void stopSharing();
      }, { once: true });
      for (const viewerId of started.viewers) {
        void ensureSenderConnection(viewerId).catch((error) => {
          setError(error instanceof Error ? error.message : 'Could not connect screen share viewer.');
        });
      }
    } catch (error) {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      const message = error instanceof Error ? error.message : 'Screen share failed.';
      setError(message);
      setStatus(isScreenSharePermissionDenied(error) ? 'permission_denied' : 'failed');
      throw error;
    }
  }, [ensureSenderConnection, stopSharing]);

  useEffect(() => {
    if (!voiceSession) {
      cleanupLocalShare(true);
      for (const shareId of [...remoteSharesRef.current.keys()]) {
        closeRemoteShare(shareId, true);
      }
      return;
    }
    for (const share of voiceSession.screenShares ?? []) {
      watchShare(share);
    }
  }, [cleanupLocalShare, closeRemoteShare, voiceSession, watchShare]);

  useEffect(() => () => {
    cleanupLocalShare(true);
    for (const shareId of [...remoteSharesRef.current.keys()]) {
      closeRemoteShare(shareId, true);
    }
  }, [cleanupLocalShare, closeRemoteShare]);

  return {
    status,
    error,
    localShare,
    remoteShares,
    startSharing,
    stopSharing,
    handleGatewayEvent,
  };
}
