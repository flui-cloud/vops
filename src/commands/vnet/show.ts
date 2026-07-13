import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetShow);
    try {
      const vnet = await (await getVopsApp())
        .get(VopsVnetService)
        .show(flags.provider, args.id);
      if (!vnet) this.error(`Network '${args.id}' not found.`, { exit: 1 });
      this.log(JSON.stringify(vnet, null, 2));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
