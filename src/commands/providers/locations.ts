import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable, yesNo } from '../../lib/output';
import { VopsProvidersService } from '../../providers/vops-providers.service';

export default class ProvidersLocations extends Command {
  static readonly description = 'List a provider regions/locations (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner',
    '<%= config.bin %> <%= command.id %> scaleway --json',
  ];

  static readonly args = {
    provider: Args.string({ description: 'hetzner | scaleway', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersLocations);
    try {
      const locations = await (await getVopsApp())
        .get(VopsProvidersService)
        .locations(args.provider);

      if (flags.json) {
        this.log(JSON.stringify(locations, null, 2));
        return;
      }

      this.log(
        renderTable(
          ['ID', 'NAME', 'COUNTRY', 'AVAILABLE'],
          locations.map((l) => [
            l.id,
            l.name,
            l.country ?? '-',
            yesNo(l.available),
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
