import type { CurrentUser, RegistrationMode } from '@current/types';
import { ALL_PERMISSIONS } from '../moderation/permissions.js';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { ServerConfigService } from '../services/server-config-service.js';

export interface SetupStatus {
  configured: boolean;
  serverId?: string;
}

export interface BootstrapInput {
  serverName: string;
  slug: string;
  publicUrl: string;
  registrationMode: RegistrationMode;
  adminDid?: string;
  adminHandle?: string;
  adminDisplayName?: string;
  adminAvatarUrl?: string;
}

export class SetupService {
  constructor(
    private readonly repos: RepositoryBag,
    private readonly serverConfig: ServerConfigService,
  ) {}

  status(): SetupStatus {
    const configured = Boolean(this.repos.settings.get<boolean>('setup_complete'));
    const server = this.repos.servers.getPrimaryServer();

    return {
      configured,
      serverId: server?.id,
    };
  }

  bootstrap(input: BootstrapInput): { serverId: string } {
    const existing = this.status();
    if (existing.configured || existing.serverId) {
      throw new Error('Server is already configured.');
    }

    const server = this.repos.servers.create({
      name: input.serverName,
      slug: input.slug,
      registrationMode: input.registrationMode,
    });

    const adminRole = this.repos.roles.create({
      serverId: server.id,
      name: 'Admin',
      color: '#ff6a3d',
      position: 100,
      permissions: ALL_PERMISSIONS,
    });

    const memberRole = this.repos.roles.create({
      serverId: server.id,
      name: 'Member',
      color: '#6bd7ff',
      position: 1,
      permissions: ['SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'ATTACH_FILES', 'USE_GIFS'],
    });

    this.repos.channels.create({
      serverId: server.id,
      name: 'general',
      type: 'text',
      topic: 'Welcome to Current',
      slowmodeSeconds: 0,
    });

    this.repos.channels.create({
      serverId: server.id,
      name: 'lounge',
      type: 'voice',
    });

    if (input.adminDid && input.adminHandle && input.adminDisplayName) {
      const adminUser = this.repos.users.upsertByDid({
        did: input.adminDid,
        handle: input.adminHandle,
        displayName: input.adminDisplayName,
        avatarUrl: input.adminAvatarUrl,
      });
      this.repos.users.addRole(adminUser.id, adminRole.id);
      this.repos.users.addRole(adminUser.id, memberRole.id);
      this.repos.settings.set('owner_user_id', adminUser.id);
    }

    this.repos.settings.set('setup_complete', true);
    this.repos.settings.set('server_id', server.id);

    this.serverConfig.patchFromSetup({
      serverName: input.serverName,
      slug: input.slug,
      publicUrl: input.publicUrl,
      registrationMode: input.registrationMode,
    });

    return { serverId: server.id };
  }

  ensureOwnerForUser(user: CurrentUser): CurrentUser {
    const status = this.status();
    if (!status.serverId) {
      return user;
    }

    const roles = this.repos.roles.list(status.serverId);
    const adminRole = roles.find((role) => role.permissions.includes('ADMINISTRATOR'));
    if (!adminRole) {
      return user;
    }

    const hasAdminAssigned = this.repos.users.hasAnyAssigneeForRole(adminRole.id);
    if (!hasAdminAssigned) {
      this.repos.users.addRole(user.id, adminRole.id);
      const memberRole = roles.find((role) => role.name.toLowerCase() === 'member');
      if (memberRole) {
        this.repos.users.addRole(user.id, memberRole.id);
      }
    }

    if (!this.getOwnerUserId()) {
      this.repos.settings.set('owner_user_id', user.id);
    }

    return this.repos.users.findById(user.id) ?? user;
  }

  getOwnerUserId(): string | null {
    return this.repos.settings.get<string>('owner_user_id');
  }

  transferOwnership(input: { serverId: string; actorId: string; targetUserId: string }): CurrentUser {
    const previousOwnerUserId = this.getOwnerUserId();
    const target = this.repos.users.findById(input.targetUserId);
    if (!target) {
      throw new Error('Target user not found.');
    }

    const roles = this.repos.roles.list(input.serverId);
    const adminRole = roles.find((role) => role.permissions.includes('ADMINISTRATOR'));
    if (!adminRole) {
      throw new Error('Admin role is missing.');
    }

    this.repos.users.addRole(target.id, adminRole.id);
    this.repos.settings.set('owner_user_id', target.id);

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'server.owner.transfer',
      targetType: 'user',
      targetId: target.id,
      payload: {
        previousOwnerUserId,
        newOwnerUserId: target.id,
      },
    });

    return this.repos.users.findById(target.id) ?? target;
  }
}
