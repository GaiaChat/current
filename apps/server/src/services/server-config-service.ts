import { isIP } from 'node:net';
import {
  createDefaultConfig,
  loadConfig,
  saveConfig,
  type CurrentConfig,
} from '@current/config';
import type { RegistrationMode } from '@current/types';

export class ServerConfigService {
  private config: CurrentConfig;

  constructor(private readonly configPath: string, initialConfig?: CurrentConfig) {
    this.config = initialConfig ?? loadConfig(configPath);
  }

  get(): CurrentConfig {
    return this.config;
  }

  set(config: CurrentConfig): void {
    this.config = config;
    saveConfig(this.configPath, config);
  }

  patchFromSetup(input: {
    serverName: string;
    slug: string;
    publicUrl: string;
    registrationMode: RegistrationMode;
  }): CurrentConfig {
    const merged = createDefaultConfig(this.config);
    const hadExplicitClientId = merged.auth.atprotoClientId.trim().length > 0;
    merged.server.name = input.serverName;
    merged.server.slug = input.slug;
    merged.server.publicUrl = input.publicUrl;
    merged.server.registrationMode = input.registrationMode;
    if (!hadExplicitClientId) {
      const discoverableClientId = this.deriveDiscoverableClientIdFromPublicUrl(input.publicUrl);
      if (discoverableClientId) {
        merged.auth.atprotoClientId = discoverableClientId;
      }
      merged.auth.redirectUri = this.buildDefaultOAuthRedirectUri(input.publicUrl);
    }
    this.set(merged);
    return merged;
  }

  patchRegistrationMode(mode: RegistrationMode): CurrentConfig {
    const merged = createDefaultConfig(this.config);
    merged.server.registrationMode = mode;
    this.set(merged);
    return merged;
  }

  patchAdminSettings(input: {
    registrationMode?: RegistrationMode;
    klipyApiKey?: string;
    lanRedirectBaseUrl?: string;
  }): CurrentConfig {
    const merged = createDefaultConfig(this.config);
    if (input.registrationMode) {
      merged.server.registrationMode = input.registrationMode;
    }
    if (input.klipyApiKey !== undefined) {
      merged.media.klipyApiKey = input.klipyApiKey.trim();
    }
    if (input.lanRedirectBaseUrl !== undefined) {
      merged.auth.lanRedirectBaseUrl = input.lanRedirectBaseUrl.trim();
    }
    this.set(merged);
    return merged;
  }

  private buildDefaultOAuthRedirectUri(publicUrl: string): string {
    const redirect = new URL(publicUrl);
    redirect.pathname = '/api/v1/auth/oauth/callback';
    redirect.search = '';
    redirect.hash = '';
    return redirect.toString();
  }

  private deriveDiscoverableClientIdFromPublicUrl(publicUrl: string): string | null {
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol !== 'https:') {
        return null;
      }
      if (parsed.hostname === 'localhost' || parsed.hostname === '::1' || isIP(parsed.hostname)) {
        return null;
      }
      if (!parsed.hostname.includes('.') || parsed.hostname.endsWith('.local')) {
        return null;
      }
      return new URL('/api/v1/auth/client-metadata.json', parsed).toString();
    } catch {
      return null;
    }
  }
}
