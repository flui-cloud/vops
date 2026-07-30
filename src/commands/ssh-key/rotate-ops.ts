import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { agentError } from '../../agent-api/agent-envelope';
import { VopsOpsRotationService } from '../../host-ops/vops-ops-rotation.service';

export default class SshKeyRotateOps extends Command {
  static readonly description =
    'Rotate the vops operations key across every host that has it installed (safe, per-host verified)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --force',
  ];

  static readonly flags = {
    'dry-run': Flags.boolean({ description: 'Show the plan per host, change nothing', default: false }),
    force: Flags.boolean({ description: 'Promote the new key even if some hosts failed', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SshKeyRotateOps);
    await runAgentCommand(
      this,
      'vops ssh-key rotate-ops',
      flags.json,
      async () => {
        const data = await withService(VopsOpsRotationService, (svc) =>
          svc.rotate({ dryRun: flags['dry-run'], force: flags.force }),
        );
        const stalled = !data.dryRun && !data.promoted;
        return {
          data,
          errors: stalled
            ? [
                agentError(
                  'VOPS_OPERATION_FAILED',
                  'operational',
                  `${data.failed.length} host(s) failed to take the new ops key; the old key is still in force.`,
                  { suggestedAction: 'Fix access on the hosts in data.failed and re-run, or re-run with --force to promote anyway.' },
                ),
              ]
            : [],
        };
      },
      (report) => {
        for (const r of report.results) {
          const tag = { rotated: chalk.green('✓'), already: chalk.dim('='), planned: chalk.cyan('~'), failed: chalk.red('✗') }[r.outcome];
          this.log(`  ${tag} ${r.host}${r.message ? chalk.dim(' — ' + r.message) : ''}`);
        }
        if (report.dryRun) this.log(chalk.cyan('\n[dry-run] no changes applied'));
        else if (report.promoted) this.log(chalk.green('\n✓ Rotation complete; new ops key promoted'));
        else this.log(chalk.yellow(`\n! ${report.failed.length} host(s) failed; old key kept. Retry, or --force to promote anyway.`));
      },
    );
  }
}
