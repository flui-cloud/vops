import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsCatalogService } from '../../catalog/vops-catalog.service';

export default class ProvidersAvailability extends Command {
  static readonly description =
    'Show per-location availability for a provider plans (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner --family cx',
    '<%= config.bin %> <%= command.id %> scaleway --json',
  ];

  static readonly args = {
    provider: Args.string({ description: 'hetzner | scaleway', required: true }),
  };

  static readonly flags = {
    family: Flags.string({ description: 'Filter by plan family prefix (e.g. cx)' }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
    refresh: Flags.boolean({ description: 'Bypass local cache', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersAvailability);
    try {
      const rows = await (await getVopsApp())
        .get(VopsCatalogService)
        .availability(args.provider, flags.family, flags.refresh);

      if (flags.json) {
        this.log(JSON.stringify(rows, null, 2));
        return;
      }

      this.log(
        renderTable(
          ['PLAN', 'AVAILABLE IN'],
          rows.map((r) => {
            const open = r.locations.filter((l) => l.available).map((l) => l.location);
            return [
              r.name,
              open.length ? open.join(', ') : chalk.dim('none'),
            ];
          }),
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
