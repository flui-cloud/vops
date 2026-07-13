import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';

export default class FirewallShow extends Command {
  static readonly description = 'Show a firewall with its rules and targets';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner',
  ];

  static readonly args = {
    id: Args.string({ description: 'Firewall id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FirewallShow);
    try {
      const fw = await (await getVopsApp())
        .get(VopsFirewallService)
        .show(flags.provider, args.id);
      if (!fw) this.error(`Firewall '${args.id}' not found.`, { exit: 1 });
      this.log(JSON.stringify(fw, null, 2));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
