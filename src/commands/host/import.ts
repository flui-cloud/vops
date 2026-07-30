import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostImport extends Command {
  static readonly description = 'Create a host from an existing provider server';

  static readonly examples = ['<%= config.bin %> <%= command.id %> ovh vops-web-abc'];

  static readonly args = {
    provider: Args.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    server: Args.string({ description: 'Server id or name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostImport);
    await runAgentCommand(
      this,
      'vops host import',
      flags.json,
      async () => {
        const data = await withService(VopsHostsService, (svc) => svc.import(args.provider, args.server));
        return {
          data,
          warnings: data.probe.reachable ? [] : [{ code: 'VOPS_HOST_UNREACHABLE', message: data.probe.message ?? 'The host did not answer over SSH.' }],
          nextActions: data.probe.reachable
            ? []
            : [{ command: `vops host status ${data.host.name} --json`, description: 'Re-probe the host once SSH access is sorted out' }],
        };
      },
      ({ host, probe }) => {
        this.log(chalk.green(`✓ Imported host '${host.name}' from ${host.provider} (${host.user}@${host.address})`));
        if (probe.reachable) this.log(chalk.dim(`  reachable · ${host.os?.pretty ?? 'unknown OS'}`));
        else this.log(chalk.yellow(`  warning: ${probe.message}`));
      },
    );
  }
}
