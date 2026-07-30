import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsHostKeysService } from '../../../host-ops/vops-host-keys.service';

export default class HostKeyInstallOps extends Command {
  static readonly description =
    'Install the vops operations key on a host (bootstrapped with your user key, then verified)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --from 203.0.113.0/24',
    '<%= config.bin %> <%= command.id %> web1 --dry-run',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    from: Flags.string({ description: 'Restrict the ops key to this source CIDR (from="…")' }),
    'dry-run': Flags.boolean({ description: 'Print what would change, apply nothing', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostKeyInstallOps);
    await runAgentCommand(
      this,
      'vops host key install-ops',
      flags.json,
      async () => ({
        data: await withService(VopsHostKeysService, (svc) =>
          svc.installOps(args.name, { fromCidr: flags.from, dryRun: flags['dry-run'] }),
        ),
      }),
      (res) => {
        if (res.dryRun === true) {
          this.log(chalk.cyan(`[dry-run] ${res.path}`));
          this.log(`  + ${res.line}`);
          this.log(chalk.dim(res.wouldChange ? '  (line would be added/updated)' : '  (already present, no change)'));
          return;
        }
        this.log(chalk.green(`✓ Ops key installed on '${res.host}' and verified`));
        if (res.alreadyPresent) this.log(chalk.dim('  (was already present)'));
      },
    );
  }
}
