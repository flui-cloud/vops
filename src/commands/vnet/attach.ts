import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetAttach extends Command {
  static readonly description = 'Attach (or --detach) a server to/from a private network';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --server 555',
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --server 555 --detach',
  ];

  static readonly args = {
    id: Args.string({ description: 'Network id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    server: Flags.string({ description: 'Server id', required: true }),
    detach: Flags.boolean({ description: 'Detach instead of attach', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetAttach);
    await runAgentCommand(
      this,
      'vops vnet attach',
      flags.json,
      async () => {
        await withService(VopsVnetService, (svc) =>
          flags.detach ? svc.detach(flags.provider, args.id, flags.server) : svc.attach(flags.provider, args.id, flags.server),
        );
        return { data: { id: args.id, server: flags.server, detached: flags.detach } };
      },
      () => this.log(chalk.green(`✓ ${flags.detach ? 'Detached from' : 'Attached to'} network ${args.id}.`)),
    );
  }
}
