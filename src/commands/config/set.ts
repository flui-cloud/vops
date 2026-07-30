import { Args, Command, Flags } from '@oclif/core';
import { CloudProvider } from '@flui-cloud/infra';
import { LocalConfigStore } from '../../lib/config/local-config-store';
import {
  credentialWriteRefusal,
  credentialWriteSummary,
} from '../../lib/config/credential-write';
import { activeProfile } from '../../lib/env-files';
import { ensureVaultUnlocked } from '../../lib/keyring/unlock';
import { resolveProvider } from '../../lib/providers';
import { LocalStore } from '../../lib/store/local-store';

export default class ConfigSet extends Command {
  static readonly description =
    'Store a provider credential locally (AES-256-GCM, never sent anywhere)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner --token $HETZNER_TOKEN',
    '<%= config.bin %> <%= command.id %> scaleway --access-key $AK --secret-key $SK',
  ];

  static readonly args = {
    provider: Args.string({ description: 'hetzner | scaleway', required: true }),
  };

  static readonly flags = {
    token: Flags.string({ description: 'API token (Hetzner)', env: 'VOPS_TOKEN' }),
    'access-key': Flags.string({ description: 'Access key (Scaleway)', env: 'VOPS_ACCESS_KEY' }),
    'secret-key': Flags.string({ description: 'Secret key (Scaleway)', env: 'VOPS_SECRET_KEY' }),
    force: Flags.boolean({
      description: 'Replace an existing credential for this provider (not reversible)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConfigSet);
    const provider = resolveProvider(args.provider);
    await ensureVaultUnlocked();
    const store = new LocalConfigStore();

    if (provider === CloudProvider.CHERRY) {
      this.error(
        'Cherry reads its credentials from the environment. Set CHERRY_API_KEY and ' +
          "CHERRY_PROJECT_ID in ~/.config/vops/.env (like OVH's OS_* and Contabo's CONTABO_*).",
        { exit: 1 },
      );
    }

    const profile = activeProfile();
    const existing = store.listConfigured().includes(provider);
    const refusal = credentialWriteRefusal({
      provider,
      profile,
      profileDir: store.profileDir,
      existing,
      force: flags.force,
    });
    if (refusal) this.error(refusal, { exit: 1 });

    if (provider === CloudProvider.SCALEWAY) {
      if (!flags['access-key'] || !flags['secret-key']) {
        this.error('Scaleway requires --access-key and --secret-key', { exit: 1 });
      }
      store.setCredentials(provider, {
        accessKey: flags['access-key'],
        secretKey: flags['secret-key'],
      });
    } else {
      if (!flags.token) {
        this.error('Provide --token (or VOPS_TOKEN)', { exit: 1 });
      }
      store.setToken(provider, flags.token);
    }

    await this.audit(provider, profile, existing);
    this.log(
      credentialWriteSummary({ provider, profile, profileDir: store.profileDir, existing }),
    );
  }

  /** Records that a credential changed, never what it changed to. */
  private async audit(provider: string, profile: string, replaced: boolean): Promise<void> {
    const store = new LocalStore();
    try {
      await store.appendAudit('config.credential.set', { provider, profile, replaced });
    } catch (e) {
      this.warn(`Credential stored, but the local audit trail could not be written: ${e.message}`);
    } finally {
      await store.onModuleDestroy();
    }
  }
}
