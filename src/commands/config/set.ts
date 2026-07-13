import { Args, Command, Flags } from '@oclif/core';
import { CloudProvider } from '@flui-cloud/infra';
import { LocalConfigStore } from '../../lib/config/local-config-store';
import { resolveProvider } from '../../lib/providers';

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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConfigSet);
    const provider = resolveProvider(args.provider);
    const store = new LocalConfigStore();

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

    this.log(`✓ Stored ${provider} credentials (AES-256-GCM, ~/.config/vops).`);
  }
}
