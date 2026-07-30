import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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
    ...agentJsonFlag,
    refresh: Flags.boolean({ description: 'Bypass local cache', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersPlans);
    await runAgentCommand(
      this,
      'vops providers plans',
      flags.json,
      async () => ({ data: await withService(VopsCatalogService, (svc) => svc.plans(args.provider, flags.refresh)) }),
      (plans) =>
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
        ),
    );
  }
}
