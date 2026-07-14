import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../lib/cloud-client';
import { renderTable } from '../../lib/output';

export default class WatchList extends Command {
  static readonly description = 'List your active watches on the hosted service';

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WatchList);
    try {
      const watches = await new CloudClient().listWatches();
      if (flags.json) {
        this.log(JSON.stringify({ watches }, null, 2));
        return;
      }
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
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}
