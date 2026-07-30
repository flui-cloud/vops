import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostAdd extends Command {
  static readonly description = 'Register a host reachable over SSH (local inventory only)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1 --address 203.0.113.10',
    '<%= config.bin %> <%= command.id %> db --address db.example.com --user admin --key laptop --tag prod',
  ];

  static readonly args = {
    name: Args.string({ description: 'Unique host handle', required: true }),
  };

  static readonly flags = {
    address: Flags.string({ description: 'IP or FQDN', required: true }),
    user: Flags.string({ description: 'SSH login user', default: 'root' }),
    port: Flags.integer({ description: 'SSH port', default: 22 }),
    key: Flags.string({ description: 'Local user key name for interactive ssh' }),
    tag: Flags.string({ description: 'Tag (repeatable)', multiple: true }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostAdd);
    await runAgentCommand(
      this,
      'vops host add',
      flags.json,
      async () => {
        const { host, probe } = await withService(VopsHostsService, (svc) =>
          svc.add(args.name, {
            address: flags.address,
            user: flags.user,
            port: flags.port,
            userKeyName: flags.key,
            tags: flags.tag,
          }),
        );
        return {
          data: { host, probe },
          warnings: probe.reachable ? [] : [{ code: 'VOPS_HOST_UNREACHABLE', message: probe.message ?? 'The host did not answer over SSH.' }],
        };
      },
      ({ host, probe }) => {
        this.log(chalk.green(`✓ Added host '${host.name}' (${host.user}@${host.address}:${host.port})`));
        if (probe.reachable) {
          this.log(chalk.dim(`  reachable · ${host.os?.pretty ?? 'unknown OS'}`));
        } else {
          this.log(chalk.yellow(`  warning: ${probe.message}`));
        }
      },
    );
  }
}
