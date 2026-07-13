import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';

export default class FirewallApply extends Command {
  static readonly description =
    'Apply (or --remove) a firewall to/from servers';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner --servers 111,222',
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner --servers 111 --remove',
  ];

  static readonly args = {
    id: Args.string({ description: 'Firewall id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    servers: Flags.string({ description: 'Comma-separated server ids', required: true }),
    remove: Flags.boolean({ description: 'Remove instead of apply', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FirewallApply);
    const serverIds = flags.servers.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const svc = (await getVopsApp()).get(VopsFirewallService);
      if (flags.remove) await svc.remove(flags.provider, args.id, serverIds);
      else await svc.apply(flags.provider, args.id, serverIds);

      if (flags.json) {
        this.log(JSON.stringify({ id: args.id, serverIds, removed: flags.remove }, null, 2));
        return;
      }
      const verb = flags.remove ? 'Removed from' : 'Applied to';
      this.log(chalk.green(`✓ ${verb} ${serverIds.length} server(s).`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
