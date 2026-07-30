import { Args, Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersLocations);
    await runAgentCommand(
      this,
      'vops providers locations',
      flags.json,
      async () => ({ data: await withService(VopsProvidersService, (svc) => svc.locations(args.provider)) }),
      (locations) =>
        this.log(
          renderTable(
            ['ID', 'NAME', 'COUNTRY', 'AVAILABLE'],
            locations.map((l) => [l.id, l.name, l.country ?? '-', yesNo(l.available)]),
          ),
        ),
    );
  }
}
