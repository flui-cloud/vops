import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetRoute);
    await runAgentCommand(
      this,
      'vops vnet route',
      flags.json,
      async () => {
        await withService(VopsVnetService, (svc) =>
          flags.delete
            ? svc.deleteRoute(flags.provider, args.id, flags.destination, flags.gateway)
            : svc.addRoute(flags.provider, args.id, flags.destination, flags.gateway),
        );
        return { data: { id: args.id, destination: flags.destination, gateway: flags.gateway, deleted: flags.delete } };
      },
      () =>
        this.log(
          chalk.green(`✓ ${flags.delete ? 'Deleted' : 'Added'} route ${flags.destination} → ${flags.gateway} on ${args.id}.`),
        ),
    );
  }
}
