import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';
import { VopsFirewallRule } from '../../dto/firewall.dto';

export default class FirewallRules extends Command {
  static readonly description = "Replace a firewall's rule set (from a JSON array)";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner --rules \'[{"description":"https","direction":"in","protocol":"tcp","port":"443","sourceIps":["0.0.0.0/0"]}]\'',
  ];

  static readonly args = {
    id: Args.string({ description: 'Firewall id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    rules: Flags.string({ description: 'Rules as a JSON array', required: true }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FirewallRules);
    try {
      const parsed = JSON.parse(flags.rules);
      if (!Array.isArray(parsed)) throw new Error('--rules must be a JSON array.');
      const rules = parsed as VopsFirewallRule[];
      await (await getVopsApp())
        .get(VopsFirewallService)
        .updateRules(flags.provider, args.id, rules);

      if (flags.json) {
        this.log(JSON.stringify({ id: args.id, ruleCount: rules.length }, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Updated ${rules.length} rule(s) on ${args.id}.`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
