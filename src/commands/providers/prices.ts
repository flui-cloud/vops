import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { money, renderTable } from '../../lib/output';
import { VopsCatalogService } from '../../catalog/vops-catalog.service';

export default class ProvidersPrices extends Command {
  static readonly description =
    'List a provider plans sorted by cheapest hourly price (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner',
    '<%= config.bin %> <%= command.id %> scaleway --json',
  ];

  static readonly args = {
    provider: Args.string({ description: 'hetzner | scaleway', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
    refresh: Flags.boolean({ description: 'Bypass local cache', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersPrices);
    try {
      const plans = (
        await (await getVopsApp())
          .get(VopsCatalogService)
          .plans(args.provider, flags.refresh)
      ).sort((a, b) => (a.hourly ?? Infinity) - (b.hourly ?? Infinity));

      if (flags.json) {
        this.log(JSON.stringify(plans, null, 2));
        return;
      }

      this.log(
        renderTable(
          ['PLAN', 'vCPU', 'RAM(GB)', '€/h', '€/mo', 'CURRENCY'],
          plans.map((p) => [
            p.name,
            String(p.cores),
            String(p.memoryGb),
            money(p.hourly),
            money(p.monthly, 2),
            p.currency,
          ]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), {
        exit: 1,
      });
    } finally {
      await closeVopsApp();
    }
  }
}
