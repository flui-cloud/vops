import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetSubnet);
    try {
      const svc = (await getVopsApp()).get(VopsVnetService);
      if (flags.delete) {
        await svc.deleteSubnet(flags.provider, args.id, flags['ip-range']);
      } else {
        if (!flags.zone) this.error('--zone is required when adding a subnet.', { exit: 1 });
        await svc.addSubnet(flags.provider, args.id, flags.zone, flags['ip-range']);
      }

      if (flags.json) {
        this.log(JSON.stringify({ id: args.id, ipRange: flags['ip-range'], deleted: flags.delete }, null, 2));
        return;
      }
      const verb = flags.delete ? 'Deleted' : 'Added';
      this.log(chalk.green(`✓ ${verb} subnet ${flags['ip-range']} on ${args.id}.`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
