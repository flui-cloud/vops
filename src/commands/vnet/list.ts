import { Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetList extends Command {
  static readonly description = 'List private networks on a provider account (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VnetList);
    await runAgentCommand(
      this,
      'vops vnet list',
      flags.json,
      async () => ({ data: await withService(VopsVnetService, (svc) => svc.list(flags.provider)) }),
      (vnets) =>
        this.log(
          renderTable(
            ['ID', 'NAME', 'IP RANGE', 'SUBNETS', 'SERVERS'],
            vnets.map((v) => [v.id, v.name, v.ipRange, String(v.subnets.length), String(v.attachedServerIds.length)]),
          ),
        ),
    );
  }
}
