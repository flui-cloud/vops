import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { agentError } from '../../agent-api/agent-envelope';
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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostHarden);
    await runAgentCommand(
      this,
      'vops host harden',
      flags.json,
      async () => {
        const steps = flags.steps?.split(',').map((s) => s.trim()).filter(Boolean);
        const data = await withService(VopsHostHardenService, (svc) =>
          svc.harden(args.name, { user: flags.user, steps, dryRun: flags['dry-run'] }),
        );
        const failed = data.findings.filter((f) => f.severity === 'fail');
        return {
          data,
          errors: failed.length
            ? [
                agentError(
                  'VOPS_OPERATION_FAILED',
                  'operational',
                  `${failed.length} hardening step(s) failed on '${data.host}': ${failed.map((f) => f.id).join(', ')}.`,
                  { suggestedAction: 'Read data.findings for the detail of each failed step, then re-run once the cause is fixed.' },
                ),
              ]
            : [],
        };
      },
      (res) => {
        this.log(chalk.bold(res.host) + (res.dryRun ? chalk.cyan('  [dry-run]') : ''));
        for (const f of res.findings) {
          this.log(`  ${severityBadge(f.severity)}  ${chalk.dim(f.id.padEnd(20))} ${f.summary}`);
          if (f.detail && (res.dryRun || f.severity === 'fail')) {
            this.log(chalk.dim(f.detail.split('\n').map((l) => '         ' + l).join('\n')));
          }
        }
      },
    );
  }
}
