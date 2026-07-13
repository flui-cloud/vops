import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LocalConfigStore } from '../../lib/config/local-config-store';

export default class ConfigList extends Command {
  static readonly description = 'List providers with locally-configured credentials';

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ConfigList);
    const configured = new LocalConfigStore().listConfigured();

    if (flags.json) {
      this.log(JSON.stringify({ configured }, null, 2));
      return;
    }

    if (!configured.length) {
      this.log(chalk.dim('No credentials configured. Run: vops config set <provider>'));
      return;
    }
    for (const provider of configured) {
      this.log(`${chalk.green('✓')} ${provider}`);
    }
  }
}
