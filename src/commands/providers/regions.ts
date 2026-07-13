import { Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable, money } from '../../lib/output';
import { VopsRegionsService } from '../../regions/vops-regions.service';

export default class ProvidersRegions extends Command {
  static readonly description =
    'Unified list of every provider region with the cheapest "from" price';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    refresh: Flags.boolean({ description: 'Bypass local cache', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProvidersRegions);
    try {
      const result = await (await getVopsApp())
        .get(VopsRegionsService)
        .regions(flags.refresh);

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2));
        return;
      }
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
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
