import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../../lib/cloud-client';
import { renderTable } from '../../../lib/output';

export default class WatchUptimeList extends Command {
  static readonly description = 'List your uptime monitors on the hosted service';

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WatchUptimeList);
    try {
      const monitors = await new CloudClient().listUptime();
      if (flags.json) {
        this.log(JSON.stringify({ monitors }, null, 2));
        return;
      }
      if (!monitors.length) {
        this.log(chalk.dim('No uptime monitors. Add one: vops watch uptime add <name> --target <host|url>'));
        return;
      }
      this.log(
        renderTable(
          ['ID', 'NAME', 'CHECK', 'TARGET', 'STATE', 'CERT'],
          monitors.map((m) => [
            m.id,
            m.name,
            m.check,
            m.target,
            stateBadge(m.state),
            m.certExpiresAt ? new Date(m.certExpiresAt).toISOString().slice(0, 10) : chalk.dim('-'),
          ]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}

function stateBadge(state: string): string {
  if (state === 'up') return chalk.green('up');
  if (state === 'down') return chalk.red('down');
  return chalk.dim('unknown');
}
