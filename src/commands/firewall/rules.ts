import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FirewallRules);
    await runAgentCommand(
      this,
      'vops firewall rules',
      flags.json,
      async () => {
        const parsed = JSON.parse(flags.rules);
        if (!Array.isArray(parsed)) throw new Error('--rules must be a JSON array.');
        const rules = parsed as VopsFirewallRule[];
        await withService(VopsFirewallService, (svc) => svc.updateRules(flags.provider, args.id, rules));
        return { data: { id: args.id, ruleCount: rules.length } };
      },
      (res) => this.log(chalk.green(`✓ Updated ${res.ruleCount} rule(s) on ${res.id}.`)),
    );
  }
}
