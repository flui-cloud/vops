import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsCatalogService } from '../../catalog/vops-catalog.service';

/**
 * The reading is always a snapshot from the hosted catalog, never a live call to
 * the provider. Saying so on every run is the difference between a cache and a
 * cache passed off as the truth — and a stale one is worth a louder colour.
 */
function provenance(ageSeconds: number | null, stale: boolean): string {
  if (ageSeconds == null) {
    return chalk.yellow('vops catalog · age unknown');
  }
  const age = ageSeconds < 90 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)}m`;
  const line = `vops catalog · updated ${age} ago`;
  return stale ? chalk.yellow(`${line} (stale)`) : chalk.dim(line);
}

export default class ProvidersAvailability extends Command {
  static readonly description =
    'Show per-location availability for a provider plans (from the vops catalog — no credentials needed)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner --family cx',
    '<%= config.bin %> <%= command.id %> scaleway --json',
  ];

  static readonly args = {
    provider: Args.string({
      description: 'hetzner | scaleway | contabo | ovh',
      required: true,
    }),
  };

  static readonly flags = {
    family: Flags.string({ description: 'Filter by plan family prefix (e.g. cx)' }),
    ...agentJsonFlag,
    refresh: Flags.boolean({ description: 'Bypass the local cache', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersAvailability);
    await runAgentCommand(
      this,
      'vops providers availability',
      flags.json,
      async () => ({
        data: await withService(VopsCatalogService, (svc) => svc.availability(args.provider, flags.family, flags.refresh)),
      }),
      (result) => {
        // "We don't track this" and "nothing is available" are opposite answers;
        // printing an empty table for the first would be a lie.
        if (!result.live) {
          this.log(chalk.dim(`The vops catalog does not publish per-location availability for ${args.provider}.`));
          return;
        }
        this.log(
          renderTable(
            ['PLAN', 'AVAILABLE IN'],
            result.plans.map((r) => {
              if (r.everywhere) return [r.name, chalk.green('all regions')];
              const open = r.locations.filter((l) => l.available).map((l) => l.location);
              return [r.name, open.length ? open.join(', ') : chalk.dim('none')];
            }),
          ),
        );
        this.log(provenance(result.ageSeconds, result.stale));
      },
    );
  }
}
