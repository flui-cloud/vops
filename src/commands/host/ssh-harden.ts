import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsSshLockdownService, LockdownPreflight } from '../../host-ops/vops-ssh-lockdown.service';

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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostSshHarden);
    try {
      const app = await getVopsApp();
      const svc = app.get(VopsSshLockdownService);

      if (!flags.yes) {
        const pre = await svc.preflight(args.name);
        if (flags.json) { this.log(JSON.stringify(pre, null, 2)); return; }
        this.renderPreflight(pre);
        return;
      }

      const res = await svc.disable(args.name, { override: flags.override });
      if (flags.json) { this.log(JSON.stringify(res, null, 2)); return; }
      this.log(res.applied ? chalk.green(`✓ ${res.message}`) : chalk.dim(res.message));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
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
