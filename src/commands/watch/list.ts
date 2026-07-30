import { Command } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../lib/cloud-client';
import { renderTable } from '../../lib/output';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class WatchList extends Command {
  static readonly description = 'List your active watches on the hosted service';

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(WatchList);
    await runAgentCommand(
      this,
      'vops watch list',
      flags.json,
      async () => ({ data: { watches: await new CloudClient().listWatches() } }),
      ({ watches }) => {
        if (!watches.length) {
          this.log(chalk.dim('No watches. Add one: vops watch plan add <provider> <serverType> --ntfy-topic <topic>'));
          return;
        }
        this.log(
          renderTable(
            ['ID', 'PROVIDER', 'PLAN', 'LOCATION', 'KINDS', 'CHANNELS'],
            watches.map((w) => [
              w.id,
              w.provider,
              w.serverType,
              w.location ?? chalk.dim('any'),
              w.kinds.join(','),
              w.channels.join(','),
            ]),
          ),
        );
      },
    );
  }
}
