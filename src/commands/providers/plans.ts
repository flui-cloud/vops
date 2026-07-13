import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { money, renderTable, createLabel } from '../../lib/output';
import { VopsCatalogService } from '../../catalog/vops-catalog.service';

export default class ProvidersPlans extends Command {
  static readonly description =
    'List a provider compute plans with specs and price (live)';

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
    const { args, flags } = await this.parse(ProvidersPlans);
    try {
      const plans = await (
        await getVopsApp()
      )
        .get(VopsCatalogService)
        .plans(args.provider, flags.refresh);

      if (flags.json) {
        this.log(JSON.stringify(plans, null, 2));
        return;
      }

      this.log(
        renderTable(
          ['PLAN', 'vCPU', 'RAM(GB)', 'DISK(GB)', 'ARCH', '€/h', '€/mo', 'CREATE'],
          plans.map((p) => [
            p.name,
            String(p.cores),
            String(p.memoryGb),
            String(p.diskGb),
            p.arch,
            money(p.hourly),
            money(p.monthly, 2),
            createLabel(p.createAllowed, p.guided),
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
