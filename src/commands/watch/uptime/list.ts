import { Command } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../../lib/cloud-client';
import { renderTable } from '../../../lib/output';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';

export default class WatchUptimeList extends Command {
  static readonly description = 'List your uptime monitors on the hosted service';

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(WatchUptimeList);
    await runAgentCommand(
      this,
      'vops watch uptime list',
      flags.json,
      async () => ({ data: { monitors: await new CloudClient().listUptime() } }),
      ({ monitors }) => {
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
      },
    );
  }
}

function stateBadge(state: string): string {
  if (state === 'up') return chalk.green('up');
  if (state === 'down') return chalk.red('down');
  return chalk.dim('unknown');
}
