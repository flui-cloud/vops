import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { severityBadge } from '../../lib/output';
import { VopsHostHardenService } from '../../host-ops/vops-host-harden.service';

export default class HostHarden extends Command {
  static readonly description = 'Apply idempotent hardening steps to a host (SSH lockdown, updates, rate-limit)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1 --dry-run',
    '<%= config.bin %> <%= command.id %> web1 --user admin',
    '<%= config.bin %> <%= command.id %> web1 --steps ssh-no-root-pw,ssh-no-password',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    user: Flags.string({ description: 'Create this sudo admin user + install your user key' }),
    steps: Flags.string({ description: 'Comma-separated step ids (default: all)' }),
    'dry-run': Flags.boolean({ description: 'Print the file diffs / commands, apply nothing', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostHarden);
    try {
      const steps = flags.steps?.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await (await getVopsApp())
        .get(VopsHostHardenService)
        .harden(args.name, { user: flags.user, steps, dryRun: flags['dry-run'] });
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      this.log(chalk.bold(res.host) + (res.dryRun ? chalk.cyan('  [dry-run]') : ''));
      for (const f of res.findings) {
        this.log(`  ${severityBadge(f.severity)}  ${chalk.dim(f.id.padEnd(20))} ${f.summary}`);
        if (f.detail && (res.dryRun || f.severity === 'fail')) {
          this.log(chalk.dim(f.detail.split('\n').map((l) => '         ' + l).join('\n')));
        }
      }
      if (res.findings.some((f) => f.severity === 'fail')) this.exit(1);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
