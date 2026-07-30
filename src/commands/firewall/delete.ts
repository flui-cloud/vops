import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';

export default class FirewallDelete extends Command {
  static readonly description = 'Delete a firewall (--dry-run to preview, --yes to apply)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner --yes',
  ];

  static readonly args = {
    id: Args.string({ description: 'Firewall id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    'dry-run': Flags.boolean({ description: 'Preview without deleting', default: false }),
    yes: Flags.boolean({ description: 'Confirm deletion', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FirewallDelete);
    await runAgentCommand(
      this,
      'vops firewall delete',
      flags.json,
      async () => {
        const outcome = await withService(VopsFirewallService, (svc) =>
          svc.delete(flags.provider, args.id, { dryRun: flags['dry-run'], yes: flags.yes }),
        );
        return { data: { id: args.id, ...outcome } };
      },
      (outcome) =>
        this.log(
          outcome.dryRun
            ? chalk.yellow(`DRY RUN: would delete firewall ${args.id}. Nothing changed.`)
            : chalk.green(`✓ Deleted firewall ${args.id}.`),
        ),
    );
  }
}
