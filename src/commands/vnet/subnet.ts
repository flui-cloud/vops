import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetSubnet extends Command {
  static readonly description = 'Add (or --delete) a subnet on a private network';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --zone eu-central --ip-range 10.0.1.0/24',
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --ip-range 10.0.1.0/24 --delete',
  ];

  static readonly args = {
    id: Args.string({ description: 'Network id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    zone: Flags.string({ description: 'Network zone (for add)' }),
    'ip-range': Flags.string({ description: 'Subnet CIDR', required: true }),
    delete: Flags.boolean({ description: 'Delete the subnet instead of adding', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetSubnet);
    await runAgentCommand(
      this,
      'vops vnet subnet',
      flags.json,
      async () => {
        await withService(VopsVnetService, (svc) => {
          if (flags.delete) return svc.deleteSubnet(flags.provider, args.id, flags['ip-range']);
          if (!flags.zone) throw new Error('--zone is required when adding a subnet.');
          return svc.addSubnet(flags.provider, args.id, flags.zone, flags['ip-range']);
        });
        return { data: { id: args.id, ipRange: flags['ip-range'], deleted: flags.delete } };
      },
      () => this.log(chalk.green(`✓ ${flags.delete ? 'Deleted' : 'Added'} subnet ${flags['ip-range']} on ${args.id}.`)),
    );
  }
}
