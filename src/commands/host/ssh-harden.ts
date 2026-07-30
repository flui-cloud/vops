import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { preflightRefusal } from '../../host-ops/ssh-lockdown-refusal';
import { VopsSshLockdownService, LockdownPreflight, LockdownResult } from '../../host-ops/vops-ssh-lockdown.service';

export default class HostSshHarden extends Command {
  static readonly description =
    'Disable SSH password login safely (key-only). Lock-out-proof: it refuses unless your own key is proven ' +
    "to work and no other account relies on a password, verifies the change, and arms a timed auto-revert. " +
    'Without --yes it only reports what would happen.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --yes',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    override: Flags.boolean({ description: 'Proceed even though other accounts logged in with a password recently', default: false }),
    yes: Flags.boolean({ description: 'Apply the change (otherwise only preflight is shown)', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostSshHarden);
    await runAgentCommand<LockdownPreflight | LockdownResult>(
      this,
      'vops host ssh-harden',
      flags.json,
      async () => {
        const data = await withService<VopsSshLockdownService, LockdownPreflight | LockdownResult>(
          VopsSshLockdownService,
          (svc) => (flags.yes ? svc.disable(args.name, { override: flags.override }) : svc.preflight(args.name)),
        );
        return { data, ...(isPreflight(data) ? preflightRefusal(data) : {}) };
      },
      (data) => {
        if (isPreflight(data)) this.renderPreflight(data);
        else this.log(data.applied ? chalk.green(`✓ ${data.message}`) : chalk.dim(data.message));
      },
    );
  }

  private renderPreflight(pre: LockdownPreflight): void {
    this.log(`${chalk.bold(pre.host)}  ${chalk.dim('would disable password login (key-only)')}`);
    if (pre.alreadyHardened) { this.log(chalk.green('✓ Already hardened — nothing to do.')); return; }
    this.log(`${pre.userKeyVerified ? chalk.green('✓') : chalk.yellow('•')} your key ${pre.userKeyVerified ? 'verified' : 'not verified'}` +
      (pre.userKeyName ? chalk.dim(` (${pre.userKeyName})`) : ''));

    if (!pre.refusals.length) {
      this.log(chalk.green('✓ Safe to apply.') + chalk.dim(` Re-run with --yes (auto-reverts in ${pre.deadManMinutes} min if anything goes wrong).`));
      return;
    }
    this.log(chalk.red('Blocked:'));
    for (const r of pre.refusals) this.log(`  ${chalk.red('✗')} ${r.message}`);
    if (pre.overridable) this.log(chalk.dim('Add --override --yes to proceed anyway (you accept locking those accounts out).'));
  }
}

function isPreflight(d: LockdownPreflight | LockdownResult): d is LockdownPreflight {
  return 'refusals' in d;
}
