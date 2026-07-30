import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsHostKeysService } from '../../../host-ops/vops-host-keys.service';

export default class HostKeyRevokeOps extends Command {
  static readonly description = 'Remove the vops operations key line from a host';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --dry-run',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    force: Flags.boolean({ description: 'Revoke even if no other access path verifies', default: false }),
    'dry-run': Flags.boolean({ description: 'Print what would change, apply nothing', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostKeyRevokeOps);
    await runAgentCommand(
      this,
      'vops host key revoke-ops',
      flags.json,
      async () => ({
        data: await withService(VopsHostKeysService, (svc) =>
          svc.revokeOps(args.name, { dryRun: flags['dry-run'], force: flags.force }),
        ),
      }),
      (res) => {
        if (res.dryRun === true) {
          this.log(chalk.cyan(`[dry-run] ${res.path}`));
          this.log(chalk.dim(`  would remove ${res.wouldRemove} ops line(s); safe=${res.safe}`));
          return;
        }
        this.log(chalk.green(`✓ Ops key removed from '${res.host}' (${res.removed} line(s))`));
      },
    );
  }
}
