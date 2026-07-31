import { Command, Flags } from '@oclif/core';
import * as path from 'node:path';
import chalk from 'chalk';
import { pickBackend, resolveContext } from '../service/index';
import { appRemovalGuide } from '../service/uninstall-guide';
import { purgePlan, purgeProfile } from '../service/purge';
import { profileDir } from '../lib/profile';
import { promptSecret, isInteractive } from '../lib/keyring/prompt';

export default class Uninstall extends Command {
  static readonly description = 'Remove vops from this machine: the background service, and optionally your data';

  static readonly examples = [
    '<%= config.bin %> uninstall',
    '<%= config.bin %> uninstall --purge',
  ];

  static readonly flags = {
    purge: Flags.boolean({
      description: 'Also delete this profile\'s data: credential vault, SSH keys, hosts and metrics history',
      default: false,
    }),
    yes: Flags.boolean({ description: 'Skip the confirmation prompt (scripts)', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Uninstall);
    const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });

    const backend = pickBackend();
    const removed = backend ? backend.uninstall(ctx).removed : false;
    this.log(
      removed
        ? chalk.green('\n✓ Background service stopped and removed.')
        : chalk.dim('\n· No background service was installed.'),
    );

    if (flags.purge) await this.purge(flags.yes);
    else this.log(chalk.dim(`  Your data is untouched in ${profileDir()} — add --purge to delete it too.`));

    this.appIcon();
  }

  /**
   * The one step vops cannot do for you: no web API can uninstall a PWA, so the
   * honest thing is to say exactly where to click instead of leaving a dead icon
   * in the dock with no explanation.
   */
  private appIcon(): void {
    const guide = appRemovalGuide();
    this.log(chalk.bold(`\n  ${guide.title}`));
    this.log(chalk.dim('  vops cannot remove it for you — browsers give no way to uninstall an installed app.'));
    for (const step of guide.steps) {
      this.log(chalk.dim(`    · ${step.label}`));
      if (step.command) this.log(`      ${chalk.cyan(step.command)}`);
    }
    this.log('');
  }

  private async purge(skipPrompt: boolean): Promise<void> {
    const plan = purgePlan();
    const present = plan.items.filter((i) => i.exists);
    if (!present.length) {
      this.log(chalk.dim('  Nothing left to delete for this profile.'));
      return;
    }

    this.log(chalk.yellow(`\n  About to delete this profile's data (${plan.profile}):`));
    for (const item of present) {
      const mark = item.irreplaceable ? chalk.red(' · no copy exists anywhere else') : '';
      this.log(chalk.dim(`    · ${item.label}${mark}`));
      this.log(chalk.dim(`      ${item.path}`));
    }

    if (!skipPrompt) {
      if (!isInteractive()) {
        this.error('Refusing to delete data without a confirmation. Re-run with --yes if you are sure.');
      }
      const answer = await promptSecret(`  Type the profile name (${plan.profile}) to confirm: `);
      if (answer.trim() !== plan.profile) {
        this.log(chalk.dim('\n  Cancelled — nothing was deleted.\n'));
        return;
      }
    }

    const result = purgeProfile();
    this.log(chalk.green(`\n✓ Deleted ${result.removed.length} item(s).`));
    for (const f of result.failed) this.log(chalk.yellow(`  ! Could not delete ${f.path}: ${f.error}`));
  }
}
