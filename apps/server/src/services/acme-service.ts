import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CurrentConfig } from '@current/config';
import type { ServerConfigService } from './server-config-service.js';

export interface AcmeStatus {
  mode: CurrentConfig['server']['tls']['acme']['mode'];
  enabled: boolean;
  configured: boolean;
  domain: string;
  emailConfigured: boolean;
  directoryUrl: string;
  certDir: string;
  certPath: string;
  keyPath: string;
  renewBeforeDays: number;
  challengeActive: boolean;
}

export interface AcmeIssueInput {
  email?: string;
  domain?: string;
  directoryUrl?: string;
  certDir?: string;
  renewBeforeDays?: number;
  staging?: boolean;
}

export interface AcmeIssueResult extends AcmeStatus {
  issuedAt: string;
  restartRequired: boolean;
}

export interface AcmeClientModule {
  crypto: {
    createPrivateKey: () => Promise<string | Buffer>;
    createCsr: (input: { commonName: string; altNames: string[] }) => Promise<[string | Buffer, string | Buffer]>;
  };
  Client: new (input: {
    directoryUrl: string;
    accountKey: string | Buffer;
  }) => {
    auto: (input: {
      csr: string | Buffer;
      email: string;
      termsOfServiceAgreed: boolean;
      challengePriority: ['http-01'];
      challengeCreateFn: (
        authz: unknown,
        challenge: { token: string },
        keyAuthorization: string,
      ) => Promise<void>;
      challengeRemoveFn: (
        authz: unknown,
        challenge: { token: string },
        keyAuthorization: string,
      ) => Promise<void>;
    }) => Promise<string | Buffer>;
  };
}

export type AcmeModuleLoader = () => Promise<AcmeClientModule>;

const LETS_ENCRYPT_PRODUCTION_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
const LETS_ENCRYPT_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export class AcmeService {
  private readonly challenges = new Map<string, string>();

  constructor(
    private readonly serverConfig: ServerConfigService,
    private readonly configPath: string,
    private readonly loadAcmeModule: AcmeModuleLoader = async () =>
      (await import('acme-client')) as unknown as AcmeClientModule,
  ) {}

  status(): AcmeStatus {
    const config = this.serverConfig.get();
    const certDir = this.resolveCertDir(config);
    return {
      mode: config.server.tls.acme.mode,
      enabled: config.server.tls.enabled,
      configured: Boolean(config.server.tls.certPath && config.server.tls.keyPath),
      domain: config.server.tls.acme.domain,
      emailConfigured: config.server.tls.acme.email.trim().length > 0,
      directoryUrl: config.server.tls.acme.directoryUrl,
      certDir,
      certPath: config.server.tls.certPath,
      keyPath: config.server.tls.keyPath,
      renewBeforeDays: config.server.tls.acme.renewBeforeDays,
      challengeActive: this.challenges.size > 0,
    };
  }

  getChallenge(token: string): string | null {
    return this.challenges.get(token) ?? null;
  }

  async issueCertificate(input: AcmeIssueInput = {}): Promise<AcmeIssueResult> {
    const current = this.serverConfig.get();
    const domain = (input.domain ?? current.server.tls.acme.domain).trim().toLowerCase();
    const email = (input.email ?? current.server.tls.acme.email).trim();
    const directoryUrl = input.staging
      ? LETS_ENCRYPT_STAGING_DIRECTORY
      : (input.directoryUrl ?? current.server.tls.acme.directoryUrl).trim();
    const renewBeforeDays =
      input.renewBeforeDays ?? current.server.tls.acme.renewBeforeDays ?? 30;
    const certDir = input.certDir?.trim() || this.resolveCertDir(current);

    this.assertValidIssueInput({ domain, email, directoryUrl, certDir, renewBeforeDays });

    const acme = await this.loadAcmeModule();

    const accountKey = await acme.crypto.createPrivateKey();
    const [privateKey, csr] = await acme.crypto.createCsr({
      commonName: domain,
      altNames: [domain],
    });
    const client = new acme.Client({
      directoryUrl,
      accountKey,
    });

    const certificate = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        this.challenges.set(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        this.challenges.delete(challenge.token);
      },
    });

    mkdirSync(certDir, { recursive: true });
    const certPath = join(certDir, `${domain}.crt`);
    const keyPath = join(certDir, `${domain}.key`);
    writeFileSync(certPath, certificate);
    writeFileSync(keyPath, privateKey);

    this.serverConfig.patchFullAdminSettings({
      server: {
        tls: {
          enabled: true,
          certPath,
          keyPath,
          acme: {
            mode: 'acme',
            email,
            domain,
            directoryUrl,
            certDir,
            renewBeforeDays,
          },
        },
      },
    });

    return {
      ...this.status(),
      issuedAt: new Date().toISOString(),
      restartRequired: true,
    };
  }

  private resolveCertDir(config: CurrentConfig): string {
    return config.server.tls.acme.certDir.trim() || join(dirname(this.configPath), 'certs');
  }

  private assertValidIssueInput(input: {
    domain: string;
    email: string;
    directoryUrl: string;
    certDir: string;
    renewBeforeDays: number;
  }): void {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(input.domain)) {
      throw new Error('ACME domain must be a public DNS name like chat.example.com.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      throw new Error('ACME email must be a valid contact email address.');
    }
    const parsed = new URL(input.directoryUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('ACME directory URL must use https://.');
    }
    if (!input.certDir) {
      throw new Error('ACME certificate directory cannot be empty.');
    }
    if (!Number.isInteger(input.renewBeforeDays) || input.renewBeforeDays < 1 || input.renewBeforeDays > 90) {
      throw new Error('ACME renew-before days must be between 1 and 90.');
    }
  }
}
