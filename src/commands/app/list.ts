import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsAppsService } from '../../apps/vops-apps.service';

export default class AppList extends Command {
  static readonly description = 'List deployed app installs.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --host web1'];

  static readonly flags = {
    host: Flags.string({ description: 'Filter by host' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AppList);
    await runAgentCommand(
      this,
      'vops app list',
      flags.json,
      async () => {
        const installs = await withService(VopsAppsService, (svc) => svc.list(flags.host));
        return {
          data: installs,
          nextActions: installs.length
            ? [{ command: 'vops app status <name> --json', description: 'Live units and containers for one install' }]
            : [{ command: 'vops catalog products --json', description: 'Nothing deployed — browse installable apps' }],
        };
      },
      (installs) => {
        if (!installs.length) {
          this.log(chalk.dim('No apps deployed. Install one: vops app install <id> --host <host> --yes'));
          return;
        }
        this.log(
          renderTable(
            ['NAME', 'APP', 'HOST', 'STATUS', 'ENDPOINT'],
            installs.map((i) => [
              chalk.bold(i.name),
              i.appId,
              i.host,
              i.status === 'deployed' ? chalk.green(i.status) : chalk.yellow(i.status),
              chalk.cyan(i.endpoints[0]?.url ?? chalk.dim('—')),
            ]),
          ),
        );
      },
    );
  }
}
