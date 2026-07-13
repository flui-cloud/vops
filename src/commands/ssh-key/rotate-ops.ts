import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SshKeyRotateOps);
    try {
      const report = await (await getVopsApp())
        .get(VopsOpsRotationService)
        .rotate({ dryRun: flags['dry-run'], force: flags.force });
      if (flags.json) {
        this.log(JSON.stringify(report, null, 2));
        return;
      }
      for (const r of report.results) {
        const tag = { rotated: chalk.green('✓'), already: chalk.dim('='), planned: chalk.cyan('~'), failed: chalk.red('✗') }[r.outcome];
        this.log(`  ${tag} ${r.host}${r.message ? chalk.dim(' — ' + r.message) : ''}`);
      }
      if (report.dryRun) {
        this.log(chalk.cyan('\n[dry-run] no changes applied'));
      } else if (report.promoted) {
        this.log(chalk.green('\n✓ Rotation complete; new ops key promoted'));
      } else {
        this.log(chalk.yellow(`\n! ${report.failed.length} host(s) failed; old key kept. Retry, or --force to promote anyway.`));
        this.exit(1);
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
