import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';

type RegistrationMode = 'invite_only' | 'open_signup' | 'manual_approval';

interface MemberOption {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
}

interface ServerSettingsPayload {
  server: {
    name: string;
    slug: string;
    publicUrl: string;
    registrationMode: RegistrationMode;
  };
  auth: {
    lanRedirectBaseUrl: string;
  };
  media: {
    klipyApiKey: string;
    klipyApiKeyConfigured: boolean;
    tenorApiKey?: string;
    tenorApiKeyConfigured?: boolean;
  };
  ownership: {
    ownerUserId?: string;
  };
}

interface SharedIpGroupPayload {
  ipAddress: string;
  userCount: number;
  lastSeenAt: string;
  totalHits: number;
  users: Array<{
    id: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
  }>;
}

interface ModerationLogEntryPayload {
  id: string;
  source: 'audit' | 'moderation';
  action: string;
  actorId?: string;
  targetId?: string;
  summary: string;
  createdAt: string;
  payload?: unknown;
}

type SettingsSection = 'server' | 'ownership' | 'moderation' | 'security';

export function ServerSettingsModal({
  open,
  onClose,
  canManageServer,
  members,
}: {
  open: boolean;
  onClose: () => void;
  canManageServer: boolean;
  members: MemberOption[];
}) {
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<SettingsSection>('server');
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('invite_only');
  const [klipyApiKey, setKlipyApiKey] = useState('');
  const [lanRedirectBaseUrl, setLanRedirectBaseUrl] = useState('');
  const [selectedOwnerId, setSelectedOwnerId] = useState('');
  const [transferNotice, setTransferNotice] = useState('');
  const [pendingTransferTargetId, setPendingTransferTargetId] = useState<string | null>(null);

  const membersById = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );

  const settingsQuery = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiGet<ServerSettingsPayload>('/api/v1/admin/settings'),
    enabled: open && canManageServer,
  });

  const moderationLogsQuery = useQuery({
    queryKey: ['admin-moderation-logs'],
    queryFn: () => apiGet<ModerationLogEntryPayload[]>('/api/v1/admin/moderation/logs?limit=150'),
    enabled: open && canManageServer && activeSection === 'moderation',
    refetchInterval: 15_000,
  });

  const sharedIpsQuery = useQuery({
    queryKey: ['admin-shared-ips'],
    queryFn: () => apiGet<SharedIpGroupPayload[]>('/api/v1/admin/shared-ips'),
    enabled: open && canManageServer && activeSection === 'security',
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (!open) {
      setActiveSection('server');
      setTransferNotice('');
      setPendingTransferTargetId(null);
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (pendingTransferTargetId) {
          setPendingTransferTargetId(null);
          return;
        }
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open, pendingTransferTargetId]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    const ownerUserId = settingsQuery.data.ownership.ownerUserId ?? '';
    const firstTransferCandidate = members.find((member) => member.id !== ownerUserId)?.id ?? '';

    setRegistrationMode(settingsQuery.data.server.registrationMode);
    setKlipyApiKey(settingsQuery.data.media.klipyApiKey ?? settingsQuery.data.media.tenorApiKey ?? '');
    setLanRedirectBaseUrl(settingsQuery.data.auth.lanRedirectBaseUrl ?? '');
    setSelectedOwnerId((previous) => {
      if (previous && previous !== ownerUserId && membersById.has(previous)) {
        return previous;
      }
      return firstTransferCandidate;
    });
  }, [members, membersById, settingsQuery.data]);

  const saveSettingsMutation = useMutation({
    mutationFn: () =>
      apiPatch<ServerSettingsPayload>('/api/v1/admin/settings', {
        registrationMode,
        klipyApiKey,
        lanRedirectBaseUrl,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await queryClient.invalidateQueries({ queryKey: ['setup-status'] });
    },
  });

  const transferOwnershipMutation = useMutation({
    mutationFn: (targetUserId: string) =>
      apiPost<{ ownerUserId: string }>('/api/v1/admin/ownership/transfer', {
        targetUserId,
      }),
    onSuccess: async (payload) => {
      const newOwner = membersById.get(payload.ownerUserId);
      setTransferNotice(
        newOwner
          ? `Ownership transferred to ${newOwner.displayName} (@${newOwner.handle}).`
          : 'Ownership transferred successfully.',
      );
      setPendingTransferTargetId(null);
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-moderation-logs'] });
    },
  });

  if (!open) {
    return null;
  }

  const owner = settingsQuery.data?.ownership.ownerUserId
    ? membersById.get(settingsQuery.data.ownership.ownerUserId)
    : undefined;
  const ownerUserId = settingsQuery.data?.ownership.ownerUserId ?? '';
  const transferCandidates = members.filter((member) => member.id !== ownerUserId);
  const selectedTransferTarget = selectedOwnerId ? membersById.get(selectedOwnerId) : undefined;
  const pendingTransferTarget = pendingTransferTargetId ? membersById.get(pendingTransferTargetId) : undefined;
  const canTransferOwnership = Boolean(selectedOwnerId) && selectedOwnerId !== ownerUserId;

  const sectionCopy: Record<SettingsSection, string> = {
    server: 'Configure server behavior and media integrations.',
    ownership: 'Transfer ownership and view owner state.',
    moderation: 'Review moderation and audit activity.',
    security: 'Inspect shared IP activity and safety signals.',
  };

  const handleTransferOwnership = () => {
    if (!selectedTransferTarget || !canTransferOwnership) {
      return;
    }

    setTransferNotice('');
    transferOwnershipMutation.reset();
    setPendingTransferTargetId(selectedTransferTarget.id);
  };

  const confirmOwnershipTransfer = () => {
    if (!pendingTransferTarget) {
      return;
    }
    transferOwnershipMutation.mutate(pendingTransferTarget.id);
  };

  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <h2>Server Settings</h2>
            <small>{sectionCopy[activeSection]}</small>
          </div>
          <button className="settings-close" onClick={onClose}>×</button>
        </header>

        {!canManageServer ? (
          <div className="settings-empty">
            You need `MANAGE_SERVER` (or `ADMINISTRATOR`) permission to access Server Settings.
          </div>
        ) : (
          <div className="settings-layout">
            <aside className="settings-nav" aria-label="Server settings sections">
              <button
                className={activeSection === 'server' ? 'active' : ''}
                onClick={() => setActiveSection('server')}
              >
                Server
              </button>
              <button
                className={activeSection === 'ownership' ? 'active' : ''}
                onClick={() => setActiveSection('ownership')}
              >
                Ownership
              </button>
              <button
                className={activeSection === 'moderation' ? 'active' : ''}
                onClick={() => setActiveSection('moderation')}
              >
                Moderation Logs
              </button>
              <button
                className={activeSection === 'security' ? 'active' : ''}
                onClick={() => setActiveSection('security')}
              >
                Security
              </button>
            </aside>

            <div className="settings-content">
              {activeSection === 'server' && (
                <section className="settings-card">
                  <h3>Server Controls</h3>
                  <label>
                    Registration mode
                    <select
                      value={registrationMode}
                      onChange={(event) => setRegistrationMode(event.target.value as RegistrationMode)}
                    >
                      <option value="invite_only">Invite only</option>
                      <option value="open_signup">Open signup</option>
                      <option value="manual_approval">Manual approval</option>
                    </select>
                  </label>
                  <label>
                    Klipy GIF API key
                    <input
                      value={klipyApiKey}
                      onChange={(event) => setKlipyApiKey(event.target.value)}
                      placeholder="Paste Klipy API key"
                    />
                  </label>
                  <small>
                    {(settingsQuery.data?.media.klipyApiKeyConfigured ?? settingsQuery.data?.media.tenorApiKeyConfigured)
                      ? 'Klipy GIF API is currently configured.'
                      : 'No GIF API key configured yet.'}
                  </small>
                  <label>
                    LAN OAuth host link base URL
                    <input
                      value={lanRedirectBaseUrl}
                      onChange={(event) => setLanRedirectBaseUrl(event.target.value)}
                      placeholder="http://192.168.1.121:8080"
                    />
                  </label>
                  <small>
                    Optional override for host-machine handoff links. Leave blank to auto-detect from client host.
                  </small>
                  <button onClick={() => saveSettingsMutation.mutate()} disabled={saveSettingsMutation.isPending}>
                    {saveSettingsMutation.isPending ? 'Saving…' : 'Save Settings'}
                  </button>
                  {saveSettingsMutation.error instanceof Error && (
                    <small className="settings-error">{saveSettingsMutation.error.message}</small>
                  )}
                </section>
              )}

              {activeSection === 'ownership' && (
                <section className="settings-card">
                  <h3>Ownership Transfer</h3>
                  <p>
                    Current owner: <strong>{owner?.displayName ?? 'Unassigned'}</strong>
                    {owner?.handle ? ` (@${owner.handle})` : ''}
                  </p>
                  {transferCandidates.length === 0 ? (
                    <div className="settings-empty-inline">
                      Add at least one more member before transferring ownership.
                    </div>
                  ) : (
                    <>
                      <label>
                        Transfer to
                        <select value={selectedOwnerId} onChange={(event) => setSelectedOwnerId(event.target.value)}>
                          <option value="" disabled>Select a member</option>
                          {transferCandidates.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.displayName} (@{member.handle})
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        onClick={handleTransferOwnership}
                        disabled={transferOwnershipMutation.isPending || !canTransferOwnership}
                      >
                        {transferOwnershipMutation.isPending ? 'Transferring…' : 'Transfer Ownership'}
                      </button>
                      {!canTransferOwnership && (
                        <small>Select a different member to transfer ownership.</small>
                      )}
                    </>
                  )}
                  {transferNotice && <small className="settings-success">{transferNotice}</small>}
                  {transferOwnershipMutation.error instanceof Error && (
                    <small className="settings-error">{transferOwnershipMutation.error.message}</small>
                  )}
                </section>
              )}

              {activeSection === 'moderation' && (
                <section className="settings-card">
                  <h3>Moderation Logs</h3>
                  <ul className="settings-log-list">
                    {moderationLogsQuery.isLoading && (
                      <li className="settings-empty-inline">Loading moderation logs…</li>
                    )}
                    {moderationLogsQuery.error instanceof Error && (
                      <li className="settings-empty-inline settings-error">{moderationLogsQuery.error.message}</li>
                    )}
                    {(moderationLogsQuery.data ?? []).map((entry) => {
                      const actor = entry.actorId ? membersById.get(entry.actorId) : undefined;
                      const target = entry.targetId ? membersById.get(entry.targetId) : undefined;
                      return (
                        <li key={entry.id}>
                          <div>
                            <strong>{entry.summary}</strong>
                            <small>
                              {entry.source.toUpperCase()} · {new Date(entry.createdAt).toLocaleString()}
                            </small>
                          </div>
                          <small>
                            {actor ? `By ${actor.displayName}` : 'By system'}
                            {target ? ` · Target: ${target.displayName}` : ''}
                          </small>
                        </li>
                      );
                    })}
                    {moderationLogsQuery.data?.length === 0 && !moderationLogsQuery.isLoading && (
                      <li className="settings-empty-inline">No moderation logs yet.</li>
                    )}
                  </ul>
                </section>
              )}

              {activeSection === 'security' && (
                <section className="settings-card">
                  <h3>Shared IP Insights</h3>
                  <ul className="shared-ip-list">
                    {sharedIpsQuery.isLoading && (
                      <li className="settings-empty-inline">Loading shared IP insights…</li>
                    )}
                    {sharedIpsQuery.error instanceof Error && (
                      <li className="settings-empty-inline settings-error">{sharedIpsQuery.error.message}</li>
                    )}
                    {(sharedIpsQuery.data ?? []).map((group) => (
                      <li key={group.ipAddress}>
                        <div>
                          <strong>{group.ipAddress}</strong>
                          <small>
                            {group.userCount} users · {group.totalHits} hits · last seen{' '}
                            {new Date(group.lastSeenAt).toLocaleString()}
                          </small>
                        </div>
                        <p>
                          {group.users.map((user) => `${user.displayName} (@${user.handle})`).join(', ')}
                        </p>
                      </li>
                    ))}
                    {sharedIpsQuery.data?.length === 0 && !sharedIpsQuery.isLoading && (
                      <li className="settings-empty-inline">No shared IP addresses detected yet.</li>
                    )}
                  </ul>
                </section>
              )}
            </div>
          </div>
        )}
        {pendingTransferTarget && (
          <div className="settings-warning-backdrop" onClick={() => setPendingTransferTargetId(null)}>
            <section className="settings-warning" onClick={(event) => event.stopPropagation()}>
              <h4>Confirm Ownership Transfer</h4>
              <p>
                You are about to transfer server ownership to{' '}
                <strong>
                  {pendingTransferTarget.displayName} (@{pendingTransferTarget.handle})
                </strong>
                .
              </p>
              <p className="settings-warning-copy">
                This action grants full administrative control and may lock you out of owner-only controls.
              </p>
              <div className="settings-warning-actions">
                <button onClick={() => setPendingTransferTargetId(null)} disabled={transferOwnershipMutation.isPending}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={confirmOwnershipTransfer}
                  disabled={transferOwnershipMutation.isPending}
                >
                  {transferOwnershipMutation.isPending ? 'Transferring…' : 'Transfer Ownership'}
                </button>
              </div>
              {transferOwnershipMutation.error instanceof Error && (
                <small className="settings-error">{transferOwnershipMutation.error.message}</small>
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
