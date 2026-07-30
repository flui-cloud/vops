import { Command } from '@oclif/core';
import chalk from 'chalk';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { LocalConfigStore } from '../../lib/config/local-config-store';
import { ensureVaultUnlocked } from '../../lib/keyring/unlock';

export default class ConfigList extends Command {
  static readonly description = 'List providers with locally-configured credentials';

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(ConfigList);
    await runAgentCommand(
      this,
      'vops config list',
      flags.json,
      async () => {
        await ensureVaultUnlocked();
        return { data: { configured: new LocalConfigStore().listConfigured() } };
      },
      ({ configured }) => {
        if (!configured.length) {
          this.log(chalk.dim('No credentials configured. Run: vops config set <provider>'));
          return;
        }
        for (const provider of configured) this.log(`${chalk.green('✓')} ${provider}`);
      },
    );
  }
}
