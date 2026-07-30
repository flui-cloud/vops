import { Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';

export default class FirewallList extends Command {
  static readonly description = 'List firewalls on a provider account (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(FirewallList);
    await runAgentCommand(
      this,
      'vops firewall list',
      flags.json,
      async () => ({ data: await withService(VopsFirewallService, (svc) => svc.list(flags.provider)) }),
      (firewalls) =>
        this.log(
          renderTable(
            ['ID', 'NAME', 'RULES', 'APPLIED TO'],
            firewalls.map((f) => [f.id, f.name, String(f.rules.length), String(f.appliedTo.length)]),
          ),
        ),
    );
  }
}
