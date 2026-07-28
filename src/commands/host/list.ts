import { Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostList extends Command {
  static readonly description = 'List known hosts';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json'];

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(HostList);
    await runAgentCommand(
      this,
      'vops host list',
      flags.json,
      async () => {
        const hosts = await withService(VopsHostsService, (svc) => svc.list());
        return {
          data: hosts,
          nextActions: hosts.length
            ? [{ command: 'vops host status <name> --json', description: 'Read-only SSH health check of one host' }]
            : [{ command: 'vops host add <name> --address <ip|fqdn>', description: 'No hosts yet — add or import one' }],
        };
      },
      (hosts) => {
        if (!hosts.length) {
          this.log('No hosts. Add one with: vops host add <name> --address <ip|fqdn>');
          return;
        }
        this.log(
          renderTable(
            ['NAME', 'ADDRESS', 'USER', 'OS', 'OPS KEY', 'TAGS'],
            hosts.map((h) => [
              h.name,
              `${h.address}:${h.port}`,
              h.user,
              h.os?.pretty ?? chalk.dim('unknown'),
              h.opsKeyInstalled ? chalk.green('yes') : chalk.dim('no'),
              h.tags.join(',') || chalk.dim('-'),
            ]),
          ),
        );
      },
    );
  }
}
