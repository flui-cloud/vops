import { Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';

export default class FirewallList extends Command {
  static readonly description = 'List firewalls on a provider account (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(FirewallList);
    try {
      const firewalls = await (await getVopsApp())
        .get(VopsFirewallService)
        .list(flags.provider);

      if (flags.json) {
        this.log(JSON.stringify(firewalls, null, 2));
        return;
      }
      this.log(
        renderTable(
          ['ID', 'NAME', 'RULES', 'APPLIED TO'],
          firewalls.map((f) => [
            f.id,
            f.name,
            String(f.rules.length),
            String(f.appliedTo.length),
          ]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
