import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetShow extends Command {
  static readonly description = 'Show a private network with subnets, routes and attachments';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner',
  ];

  static readonly args = {
    id: Args.string({ description: 'Network id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetShow);
    await runAgentCommand(
      this,
      'vops vnet show',
      flags.json,
      async () => {
        const vnet = await withService(VopsVnetService, (svc) => svc.show(flags.provider, args.id));
        if (!vnet) throw new Error(`Network '${args.id}' not found.`);
        return { data: vnet };
      },
      (vnet) => this.log(JSON.stringify(vnet, null, 2)),
    );
  }
}
