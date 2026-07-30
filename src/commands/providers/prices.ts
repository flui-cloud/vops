import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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
    ...agentJsonFlag,
    refresh: Flags.boolean({ description: 'Bypass local cache', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersPrices);
    await runAgentCommand(
      this,
      'vops providers prices',
      flags.json,
      async () => {
        const plans = await withService(VopsCatalogService, (svc) => svc.plans(args.provider, flags.refresh));
        plans.sort((a, b) => (a.hourly ?? Infinity) - (b.hourly ?? Infinity));
        return { data: plans };
      },
      (plans) =>
        this.log(
          renderTable(
            ['PLAN', 'vCPU', 'RAM(GB)', '€/h', '€/mo', 'CURRENCY'],
            plans.map((p) => [p.name, String(p.cores), String(p.memoryGb), money(p.hourly), money(p.monthly, 2), p.currency]),
          ),
        ),
    );
  }
}
