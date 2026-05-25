import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  VoiceCameraShare,
  VoiceCameraShareSettings,
  VoiceMediaShare,
  VoiceMediaShareSettings,
  VoiceMediaShareSignal,
  VoiceScreenShare,
  VoiceScreenShareSettings,
} from '@current/types';
import { apiPost } from '../lib/api';
import type { GatewayEnvelope } from './useGateway';
import type { VoiceSessionInfo } from './useVoiceClient';

type VoiceMediaShareStatus =
  | 'idle'
  | 'requesting_screen'
  | 'requesting_camera'
  | 'starting'
  | 'sharing'
  | 'permission_denied'
  | 'unsupported'
  | 'failed';

interface VoiceMediaShareStartResponse<TShare extends VoiceMediaShare, TSettings extends VoiceMediaShareSettings> {
  share: TShare;
  viewers: string[];
  settings: TSettings;
}

interface RemoteVoiceMediaShareEntry<TShare extends VoiceMediaShare> {
  share: TShare;
  stream: MediaStream | null;
}

export interface RemoteVoiceMediaShare<TShare extends VoiceMediaShare = VoiceMediaShare> {
  share: TShare;
  stream: MediaStream | null;
}

export interface LocalVoiceMediaShare<TShare extends VoiceMediaShare = VoiceMediaShare> {
  share: TShare;
  stream: MediaStream;
}

export type ScreenShareStatus = VoiceMediaShareStatus;
export type RemoteScreenShare = RemoteVoiceMediaShare<VoiceScreenShare>;
export type LocalScreenShare = LocalVoiceMediaShare<VoiceScreenShare>;
export type RemoteCameraShare = RemoteVoiceMediaShare<VoiceCameraShare>;
export type LocalCameraShare = LocalVoiceMediaShare<VoiceCameraShare>;

export interface VoiceCameraCaptureSettings {
  cameraDeviceId: string;
  cameraResolution: '480p' | '720p' | '1080p';
  cameraFrameRate: number;
}

interface VoiceMediaShareClientSpec<TShare extends VoiceMediaShare, TSettings extends VoiceMediaShareSettings> {
  requestStatus: Extract<VoiceMediaShareStatus, 'requesting_screen' | 'requesting_camera'>;
  disabledMessage: string;
  noTrackMessage: string;
  defaultErrorMessage: string;
  viewerErrorMessage: string;
  openErrorMessage: string;
  startedEvent: string;
  stoppedEvent: string;
  signalEvent: string;
  startedPayloadKey: 'screenShare' | 'cameraShare';
  sessionSettings: (session: VoiceSessionInfo) => TSettings;
  sessionShares: (session: VoiceSessionInfo) => TShare[];
  shareBasePath: string;
  channelSharePath: (channelId: string) => string;
  createCaptureStream: (settings: TSettings) => Promise<MediaStream>;
  applyCaptureSettings: (stream: MediaStream, settings: TSettings | TShare['constraints']) => Promise<void>;
}

function isMediaSharePermissionDenied(error: unknown): boolean {
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

function getCameraResolutionBounds(resolution: VoiceCameraCaptureSettings['cameraResolution']): { width: number; height: number } {
  if (resolution === '1080p') {
    return { width: 1920, height: 1080 };
  }
  if (resolution === '480p') {
    return { width: 854, height: 480 };
  }
  return { width: 1280, height: 720 };
}

function createCameraConstraints(
  serverSettings: VoiceCameraShareSettings,
  captureSettings?: VoiceCameraCaptureSettings,
  includeDevice = true,
): MediaTrackConstraints {
  const preferred = captureSettings
    ? getCameraResolutionBounds(captureSettings.cameraResolution)
    : { width: serverSettings.maxWidth, height: serverSettings.maxHeight };
  const frameRate = captureSettings?.cameraFrameRate ?? serverSettings.maxFrameRate;
  const constraints: MediaTrackConstraints = {
    width: { ideal: Math.min(preferred.width, serverSettings.maxWidth), max: serverSettings.maxWidth },
    height: { ideal: Math.min(preferred.height, serverSettings.maxHeight), max: serverSettings.maxHeight },
    frameRate: { ideal: Math.min(frameRate, serverSettings.maxFrameRate), max: serverSettings.maxFrameRate },
  };

  if (includeDevice && captureSettings?.cameraDeviceId && captureSettings.cameraDeviceId !== 'default') {
    constraints.deviceId = { exact: captureSettings.cameraDeviceId };
  }

  return constraints;
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

async function applyVideoCaptureSettings(
  stream: MediaStream,
  settings: VoiceMediaShareSettings | VoiceMediaShare['constraints'],
  contentHint: string,
): Promise<void> {
  await Promise.all(stream.getVideoTracks().map(async (track) => {
    track.contentHint = contentHint;
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

function useVoiceMediaShareClient<TShare extends VoiceMediaShare, TSettings extends VoiceMediaShareSettings>({
  currentUserId,
  voiceSession,
  spec,
}: {
  currentUserId?: string;
  voiceSession: VoiceSessionInfo | null;
  spec: VoiceMediaShareClientSpec<TShare, TSettings>;
}) {
  const [status, setStatus] = useState<VoiceMediaShareStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [localShare, setLocalShare] = useState<LocalVoiceMediaShare<TShare> | null>(null);
  const [remoteShares, setRemoteShares] = useState<RemoteVoiceMediaShare<TShare>[]>([]);

  const sessionRef = useRef<VoiceSessionInfo | null>(voiceSession);
  const currentUserIdRef = useRef<string | undefined>(currentUserId);
  const localShareRef = useRef<LocalVoiceMediaShare<TShare> | null>(null);
  const senderPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const viewerPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteSharesRef = useRef<Map<string, RemoteVoiceMediaShareEntry<TShare>>>(new Map());
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
    signal: VoiceMediaShareSignal,
  ) => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    await apiPost<void>(`${spec.shareBasePath}/${shareId}/signal`, {
      sessionId: session.sessionId,
      targetUserId,
      signal,
    });
  }, [spec.shareBasePath]);

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
    if (!connection || !connection.remoteDescription) {
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
      await apiPost<void>(`${spec.shareBasePath}/${current.share.id}/stop`, {
        sessionId: session.sessionId,
      }).catch(() => undefined);
    }
  }, [cleanupLocalShare, spec.shareBasePath]);

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

  const watchShare = useCallback((share: TShare) => {
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

    if (event.type === spec.startedEvent) {
      const payload = event.payload as Partial<Record<typeof spec.startedPayloadKey, TShare>>;
      const share = payload[spec.startedPayloadKey];
      if (share) {
        watchShare(share);
      }
      return;
    }

    if (event.type === spec.stoppedEvent) {
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

    if (event.type !== spec.signalEvent) {
      return;
    }

    const payload = event.payload as {
      channelId?: string;
      shareId?: string;
      fromUserId?: string;
      targetUserId?: string;
      signal?: VoiceMediaShareSignal;
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
        setError(error instanceof Error ? error.message : spec.viewerErrorMessage);
      });
      return;
    }

    if (payload.signal.type === 'viewer-left') {
      closeSenderPeer(payload.fromUserId);
      return;
    }

    if (payload.signal.type === 'offer') {
      void handleOffer(payload.shareId, payload.fromUserId, payload.signal.description).catch((error) => {
        setError(error instanceof Error ? error.message : spec.openErrorMessage);
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
    spec.openErrorMessage,
    spec.signalEvent,
    spec.startedEvent,
    spec.startedPayloadKey,
    spec.stoppedEvent,
    spec.viewerErrorMessage,
    watchShare,
  ]);

  const startSharing = useCallback(async () => {
    const session = sessionRef.current;
    const settings = session ? spec.sessionSettings(session) : null;
    if (!session || !currentUserIdRef.current) {
      throw new Error('Join a voice channel before sharing.');
    }
    if (!settings?.enabled) {
      throw new Error(spec.disabledMessage);
    }

    setStatus(spec.requestStatus);
    setError(null);
    let stream: MediaStream | null = null;
    try {
      stream = await spec.createCaptureStream(settings);
      await spec.applyCaptureSettings(stream, settings);
      const [track] = stream.getVideoTracks();
      if (!track) {
        throw new Error(spec.noTrackMessage);
      }

      setStatus('starting');
      const started = await apiPost<VoiceMediaShareStartResponse<TShare, TSettings>>(
        spec.channelSharePath(session.channelId),
        { sessionId: session.sessionId },
      );
      await spec.applyCaptureSettings(stream, started.settings);
      const share: LocalVoiceMediaShare<TShare> = {
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
          setError(error instanceof Error ? error.message : spec.viewerErrorMessage);
        });
      }
    } catch (error) {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      const message = error instanceof Error ? error.message : spec.defaultErrorMessage;
      setError(message);
      setStatus(isMediaSharePermissionDenied(error) ? 'permission_denied' : 'failed');
      throw error;
    }
  }, [ensureSenderConnection, spec, stopSharing]);

  useEffect(() => {
    if (!voiceSession) {
      cleanupLocalShare(true);
      for (const shareId of [...remoteSharesRef.current.keys()]) {
        closeRemoteShare(shareId, true);
      }
      return;
    }
    for (const share of spec.sessionShares(voiceSession) ?? []) {
      watchShare(share);
    }
  }, [cleanupLocalShare, closeRemoteShare, spec, voiceSession, watchShare]);

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

export function useVoiceScreenShareClient({
  currentUserId,
  voiceSession,
}: {
  currentUserId?: string;
  voiceSession: VoiceSessionInfo | null;
}) {
  const spec = useMemo<VoiceMediaShareClientSpec<VoiceScreenShare, VoiceScreenShareSettings>>(() => ({
    requestStatus: 'requesting_screen',
    disabledMessage: 'Screen sharing is disabled on this server.',
    noTrackMessage: 'No screen video track was returned.',
    defaultErrorMessage: 'Screen share failed.',
    viewerErrorMessage: 'Could not connect screen share viewer.',
    openErrorMessage: 'Could not open screen share.',
    startedEvent: 'VOICE_SCREEN_SHARE_STARTED',
    stoppedEvent: 'VOICE_SCREEN_SHARE_STOPPED',
    signalEvent: 'VOICE_SCREEN_SHARE_SIGNAL',
    startedPayloadKey: 'screenShare',
    sessionSettings: (session) => session.screenShare,
    sessionShares: (session) => session.screenShares,
    shareBasePath: '/api/v1/voice/screen-shares',
    channelSharePath: (channelId) => `/api/v1/voice/channels/${channelId}/screen-shares`,
    createCaptureStream: async (settings) => {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen sharing is not supported in this browser.');
      }
      return navigator.mediaDevices.getDisplayMedia(createDisplayMediaOptions(settings));
    },
    applyCaptureSettings: (stream, settings) => applyVideoCaptureSettings(stream, settings, 'detail'),
  }), []);

  return useVoiceMediaShareClient<VoiceScreenShare, VoiceScreenShareSettings>({
    currentUserId,
    voiceSession,
    spec,
  });
}

export function useVoiceCameraShareClient({
  currentUserId,
  voiceSession,
  videoSettings,
}: {
  currentUserId?: string;
  voiceSession: VoiceSessionInfo | null;
  videoSettings?: VoiceCameraCaptureSettings;
}) {
  const spec = useMemo<VoiceMediaShareClientSpec<VoiceCameraShare, VoiceCameraShareSettings>>(() => ({
    requestStatus: 'requesting_camera',
    disabledMessage: 'Camera sharing is disabled on this server.',
    noTrackMessage: 'No camera video track was returned.',
    defaultErrorMessage: 'Camera share failed.',
    viewerErrorMessage: 'Could not connect camera viewer.',
    openErrorMessage: 'Could not open camera share.',
    startedEvent: 'VOICE_CAMERA_SHARE_STARTED',
    stoppedEvent: 'VOICE_CAMERA_SHARE_STOPPED',
    signalEvent: 'VOICE_CAMERA_SHARE_SIGNAL',
    startedPayloadKey: 'cameraShare',
    sessionSettings: (session) => session.camera,
    sessionShares: (session) => session.cameraShares,
    shareBasePath: '/api/v1/voice/camera-shares',
    channelSharePath: (channelId) => `/api/v1/voice/channels/${channelId}/camera-shares`,
    createCaptureStream: async (settings) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera sharing is not supported in this browser.');
      }
      const constraints = createCameraConstraints(settings, videoSettings, true);
      return navigator.mediaDevices.getUserMedia({ video: constraints, audio: false }).catch((error) => {
        if (videoSettings?.cameraDeviceId && videoSettings.cameraDeviceId !== 'default') {
          return navigator.mediaDevices.getUserMedia({
            video: createCameraConstraints(settings, videoSettings, false),
            audio: false,
          });
        }
        throw error;
      });
    },
    applyCaptureSettings: (stream, settings) => applyVideoCaptureSettings(stream, settings, 'motion'),
  }), [videoSettings]);

  return useVoiceMediaShareClient<VoiceCameraShare, VoiceCameraShareSettings>({
    currentUserId,
    voiceSession,
    spec,
  });
}
