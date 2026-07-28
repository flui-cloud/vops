import {
  BadRequestException,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import {
  CapabilitiesProviderFactory,
  CloudProvider,
  CredentialType,
  ProviderCredentials,
} from '@flui-cloud/infra';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { ensureVaultUnlocked } from '../lib/keyring/unlock';
import { VaultLockedError } from '../lib/keyring/vault-session';
import { resolveProvider } from '../lib/providers';
import {
  CONFIGURABLE_PROVIDERS,
  clearEnvForProvider,
  hydrateEnvFromStore,
  isProviderConfigured,
} from '../lib/credentials/provider-credentials';
import {
  VopsCredentialStatus,
  VopsCredentialSaveResult,
} from '../dto/credential.dto';

/**
 * Local-first credential management for the UI/CLI. The encrypted store is the
 * single source of truth; env-based providers are served by hydrating
 * `process.env` from it at boot and after each save. Secret *values* are never
 * returned — only the field metadata and a boolean "configured" flag leave here.
 */
@Injectable()
export class VopsCredentialsService implements OnModuleInit {
  private readonly store = new LocalConfigStore();

  constructor(private readonly capabilities: CapabilitiesProviderFactory) {}

  onModuleInit(): void {
    // Make UI-stored credentials visible to env-based providers on startup.
    // An explicit environment/.env value still wins (force omitted).
    // A sealed vault is not an error here: boot must never prompt, or every
    // command would ask for the passphrase whether or not it touches a secret.
    // The credential path opens the vault later, on demand, and hydrates then.
    try {
      hydrateEnvFromStore(this.store);
    } catch (e) {
      if (!(e instanceof VaultLockedError)) throw e;
    }
  }

  async list(): Promise<VopsCredentialStatus[]> {
    await ensureVaultUnlocked();
    return Promise.all(
      CONFIGURABLE_PROVIDERS.map(async (provider) => {
        const info = await this.capabilities
          .getCapabilitiesService(provider)
          .getProviderInfo();
        return {
          provider,
          displayName: info.displayName,
          credentialType: info.credentialFields.type,
          fields: info.credentialFields.fields,
          configured: isProviderConfigured(this.store, provider),
        };
      }),
    );
  }

  async save(
    name: string,
    values: Record<string, string> | undefined,
  ): Promise<VopsCredentialSaveResult> {
    await ensureVaultUnlocked();
    const provider = resolveProvider(name);
    const info = await this.capabilities
      .getCapabilitiesService(provider)
      .getProviderInfo();
    const fields = info.credentialFields.fields;

    const clean = (v: string | undefined) => (v ?? '').trim();
    const missing = fields
      .filter((f) => f.required && !clean(values?.[f.key]))
      .map((f) => f.key);
    if (missing.length) {
      throw new BadRequestException(
        `Missing required field(s): ${missing.join(', ')}`,
      );
    }

    // Persist only declared fields — never stray keys the form might send.
    const record: Record<string, string> = {};
    for (const f of fields) {
      const v = clean(values?.[f.key]);
      if (v) record[f.key] = v;
    }
    this.store.setCredentials(provider, record);
    hydrateEnvFromStore(this.store, { force: true, only: provider });

    const validation = await this.validate(
      provider,
      info.credentialFields.type,
      record,
    );
    return { provider, configured: true, validation };
  }

  async remove(name: string): Promise<{ provider: CloudProvider; configured: false }> {
    await ensureVaultUnlocked();
    const provider = resolveProvider(name);
    this.store.remove(provider);
    clearEnvForProvider(provider);
    return { provider, configured: false };
  }

  private async validate(
    provider: CloudProvider,
    type: CredentialType,
    values: Record<string, string>,
  ): Promise<{ ok: boolean; message: string | null }> {
    const credentials: ProviderCredentials = {
      provider,
      type,
      apiKey: values.apiKey,
      accessKey: values.accessKey,
      secretKey: values.secretKey,
      username: values.username,
      password: values.password,
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      projectId: values.projectId,
    };
    try {
      const res = await this.capabilities
        .getCapabilitiesService(provider)
        .validateCredentials(credentials);
      return { ok: res.success, message: res.message ?? null };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }
}
