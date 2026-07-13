import { Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../lib/nest';
import { money, renderTable, createLabel, regionsLabel } from '../lib/output';
import { VopsCatalogService } from '../catalog/vops-catalog.service';

export default class Compare extends Command {
  static readonly description =
    'Compare live plans across providers by CPU/RAM/region, sorted by price';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --cpu 2 --ram 4gb --region fsn1',
    '<%= config.bin %> <%= command.id %> --cpu 4 --ram 8gb --hourly-only --json',
  ];

  static readonly flags = {
    cpu: Flags.integer({ description: 'Minimum vCPU' }),
    ram: Flags.string({ description: 'Minimum RAM (e.g. 4gb, 4096mb)' }),
    region: Flags.string({ description: 'Restrict to a region/location id' }),
    provider: Flags.string({ description: 'Restrict to one provider' }),
    'hourly-only': Flags.boolean({
      description: 'Only plans allowed for creation (hourly, not bare metal)',
      default: false,
    }),
    refresh: Flags.boolean({ description: 'Bypass local cache', default: false }),
    deprecated: Flags.boolean({
      description: 'Also show retired (deprecated) plans/regions — hidden by default',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Compare);
    try {
      const rows = await (await getVopsApp()).get(VopsCatalogService).compare({
        cpu: flags.cpu,
        ramGb: parseRamGb(flags.ram),
        region: flags.region,
        provider: flags.provider,
        hourlyOnly: flags['hourly-only'],
        refresh: flags.refresh,
        includeDeprecated: flags.deprecated,
      });

      if (flags.json) {
        this.log(JSON.stringify(rows, null, 2));
        return;
      }

      this.log(
        renderTable(
          ['PROVIDER', 'PLAN', 'vCPU', 'RAM(GB)', 'REGION', 'AVAIL', '€/h', '€/mo', 'CREATE'],
          rows.map((r) => [
            r.provider,
            r.plan,
            String(r.cores),
            String(r.memoryGb),
            r.region,
            regionsLabel(r.regions),
            money(r.hourly),
            money(r.monthly, 2),
            createLabel(r.createAllowed, r.guided, r.deprecated),
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

const RAM_PATTERN = /^([\d.]+)\s*(gb|g|mb|m)?$/;

function parseRamGb(input?: string): number | undefined {
  if (!input) return undefined;
  const match = RAM_PATTERN.exec(input.toLowerCase());
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  return match[2]?.startsWith('m') ? value / 1024 : value;
}
