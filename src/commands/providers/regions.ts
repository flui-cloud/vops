import { Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable, money } from '../../lib/output';
import { VopsRegionsService } from '../../regions/vops-regions.service';

export default class ProvidersRegions extends Command {
  static readonly description =
    'Unified list of every provider region with the cheapest "from" price';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    refresh: Flags.boolean({ description: 'Bypass local cache', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProvidersRegions);
    await runAgentCommand(
      this,
      'vops providers regions',
      flags.json,
      async () => ({ data: await withService(VopsRegionsService, (svc) => svc.regions(flags.refresh)) }),
      (result) => {
        this.log(
          renderTable(
            ['PROVIDER', 'REGION', 'CITY', 'COUNTRY', 'FROM/mo', 'FROM/h', 'SRC'],
            result.regions.map((r) => [
              r.provider,
              r.code,
              r.city,
              r.country,
              money(r.fromMonthly, 2) + ' ' + r.currency,
              money(r.fromHourly),
              r.live ? 'live' : 'seed',
            ]),
          ),
        );
        this.log(`\nsource: ${result.source} · updated ${result.updatedAt}`);
      },
    );
  }
}
