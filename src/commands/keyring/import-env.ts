import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LocalConfigStore } from '../../lib/config/local-config-store';
import { planEnvImport, pruneEnvFile, readEnvValues } from '../../lib/keyring/env-import';
import { ensureVaultUnlocked } from '../../lib/keyring/unlock';
import { vaultExists } from '../../lib/keyring/vault-store';
import { profileDir } from '../../lib/profile';

export default class KeyringImportEnv extends Command {
  static readonly description = 'Move credentials out of the plaintext .env and into the vault';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --prune',
  ];

  static readonly flags = {
    file: Flags.string({ description: 'Env file to read (default: ~/.config/vops/.env)' }),
    prune: Flags.boolean({ description: 'Delete the imported lines from the file (keeps a 0600 .bak)', default: false }),
    'dry-run': Flags.boolean({ description: 'Show what would move, change nothing', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(KeyringImportEnv);
    const dir = profileDir();
    if (!vaultExists(dir)) {
      this.error('This profile is not sealed yet. Run: vops keyring init', { exit: 1 });
    }

    const plan = planEnvImport(flags.file);
    if (!plan.entries.length) {
      this.log(chalk.dim(`\nNo credentials found in ${plan.file}.\n`));
      return;
    }

    // Names only — the point of this command is that the values stop being
    // printable, so it does not print them even in a dry run.
    for (const entry of plan.entries) {
      const tag = entry.kind === 'secret' ? chalk.yellow('secret   ') : chalk.dim('companion');
      this.log(`  ${tag}  ${entry.name}`);
    }
    if (plan.ignored.length) this.log(chalk.dim(`  leaving alone: ${plan.ignored.join(', ')}`));

    if (flags['dry-run']) {
      this.log(chalk.dim('\n  Dry run — nothing was written.\n'));
      return;
    }

    await ensureVaultUnlocked({ dir });
    new LocalConfigStore().setEnv(readEnvValues(plan));
    this.log(chalk.green(`\n✓ Imported ${plan.entries.length} variable(s) into the vault.`));

    if (!flags.prune) {
      this.log(chalk.yellow('  ! Still in plaintext, and still winning over the vault.'));
      this.log(chalk.dim('    Re-run with --prune to remove them from the file.\n'));
      return;
    }
    const { removed, backup } = pruneEnvFile(plan.file, plan.entries.map((e) => e.name));
    this.log(`  Removed ${removed.length} line(s) from ${plan.file}.`);
    this.log(chalk.dim(`  Backup: ${backup} — delete it once you are satisfied.\n`));
  }
}
