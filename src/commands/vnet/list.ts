import { Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetList extends Command {
  static readonly description = 'List private networks on a provider account (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VnetList);
    try {
      const vnets = await (await getVopsApp())
        .get(VopsVnetService)
        .list(flags.provider);

      if (flags.json) {
        this.log(JSON.stringify(vnets, null, 2));
        return;
      }
      this.log(
        renderTable(
          ['ID', 'NAME', 'IP RANGE', 'SUBNETS', 'SERVERS'],
          vnets.map((v) => [
            v.id,
            v.name,
            v.ipRange,
            String(v.subnets.length),
            String(v.attachedServerIds.length),
          ]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
