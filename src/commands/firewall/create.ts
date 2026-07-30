import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';
import { VopsFirewallRule } from '../../dto/firewall.dto';

export default class FirewallCreate extends Command {
  static readonly description =
    'Create a firewall (--dry-run to preview, --yes to apply)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner --name web --dry-run',
    '<%= config.bin %> <%= command.id %> --provider hetzner --name web --rules \'[{"description":"ssh","direction":"in","protocol":"tcp","port":"22","sourceIps":["0.0.0.0/0"]}]\' --yes',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    name: Flags.string({ description: 'Firewall name', required: true }),
    rules: Flags.string({ description: 'Rules as a JSON array' }),
    apply: Flags.string({ description: 'Comma-separated server ids to apply to' }),
    'dry-run': Flags.boolean({ description: 'Preview without creating', default: false }),
    yes: Flags.boolean({ description: 'Confirm creation', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(FirewallCreate);
    let ruleCount = 0;
    await runAgentCommand(
      this,
      'vops firewall create',
      flags.json,
      async () => {
        const rules = parseRules(flags.rules);
        ruleCount = rules.length;
        return {
          data: await withService(VopsFirewallService, (svc) =>
            svc.create(
              { provider: flags.provider, name: flags.name, rules, applyToServerIds: splitCsv(flags.apply) },
              { dryRun: flags['dry-run'], yes: flags.yes },
            ),
          ),
        };
      },
      (outcome) => {
        if (outcome.dryRun) {
          this.log(chalk.yellow(`DRY RUN: would create firewall '${flags.name}' on ${flags.provider} with ${ruleCount} rule(s). Nothing changed.`));
          return;
        }
        this.log(chalk.green(`✓ Firewall created: ${outcome.firewall?.id}`));
      },
    );
  }
}

function parseRules(raw?: string): VopsFirewallRule[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('--rules must be a JSON array.');
  return parsed as VopsFirewallRule[];
}

function splitCsv(raw?: string): string[] | undefined {
  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
}
