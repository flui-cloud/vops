import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetRoute extends Command {
  static readonly description = 'Add (or --delete) a route on a private network';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --destination 10.100.0.0/24 --gateway 10.0.0.1',
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --destination 10.100.0.0/24 --gateway 10.0.0.1 --delete',
  ];

  static readonly args = {
    id: Args.string({ description: 'Network id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    destination: Flags.string({ description: 'Destination CIDR', required: true }),
    gateway: Flags.string({ description: 'Gateway IP', required: true }),
    delete: Flags.boolean({ description: 'Delete the route instead of adding', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetRoute);
    try {
      const svc = (await getVopsApp()).get(VopsVnetService);
      if (flags.delete) {
        await svc.deleteRoute(flags.provider, args.id, flags.destination, flags.gateway);
      } else {
        await svc.addRoute(flags.provider, args.id, flags.destination, flags.gateway);
      }

      if (flags.json) {
        this.log(JSON.stringify({ id: args.id, destination: flags.destination, gateway: flags.gateway, deleted: flags.delete }, null, 2));
        return;
      }
      const verb = flags.delete ? 'Deleted' : 'Added';
      this.log(chalk.green(`✓ ${verb} route ${flags.destination} → ${flags.gateway} on ${args.id}.`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
