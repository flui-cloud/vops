import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LocalConfigStore } from '../../lib/config/local-config-store';
import { planEnvImport, pruneEnvFile, readEnvValues } from '../../lib/keyring/env-import';
import { promptNewSecret } from '../../lib/keyring/prompt';
import { PASSPHRASE_ENV } from '../../lib/keyring/unlock';
import { setVaultKey } from '../../lib/keyring/vault-session';
import {
  createVault,
  legacyExists,
  migrateLegacy,
  vaultExists,
  vaultPath,
} from '../../lib/keyring/vault-store';
import { profileDir } from '../../lib/profile';

export default class KeyringInit extends Command {
  static readonly description =
    'Protect this profile with a passphrase: the encryption key is derived, never stored';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --prune-env',
  ];

  static readonly flags = {
    'import-env': Flags.boolean({
      description: 'Adopt credentials found in the plaintext ~/.config/vops/.env',
      default: true,
      allowNo: true,
    }),
    'prune-env': Flags.boolean({
      description: 'Also delete the adopted lines from the .env (keeps a 0600 .bak)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(KeyringInit);
    const dir = profileDir();
    if (vaultExists(dir)) {
      this.error(`A vault already exists at ${vaultPath(dir)}. See: vops keyring status`, { exit: 1 });
    }

    // VOPS_PASSPHRASE skips the confirmation prompt: a scripted setup has no
    // second entry to compare against, and the caller already owns the value.
    const fromEnv = process.env[PASSPHRASE_ENV]?.trim();
    if (!fromEnv) {
      this.log(chalk.dim('\n  The passphrase is never written down. Lose it and the vault stays sealed.\n'));
    }
    const passphrase = fromEnv || (await promptNewSecret('Choose a vault passphrase'));

    const carried = legacyExists(dir);
    const { vault, migrated } = carried
      ? migrateLegacy(dir, passphrase)
      : { vault: createVault(dir, passphrase), migrated: [] as string[] };
    setVaultKey(vault.key);

    this.log(chalk.green(`\n✓ Vault created at ${vaultPath(dir)}`));
    if (carried) {
      this.log(
        `  Carried over: ${migrated.length ? migrated.join(', ') : chalk.dim('(nothing stored yet)')}`,
      );
    }

    if (flags['import-env']) this.importEnv(flags['prune-env']);

    this.log(chalk.dim('\n  Next: `vops keyring status`. Commands that need a credential will ask'));
    this.log(chalk.dim('  for the passphrase once, then stay unlocked for 12 hours.\n'));
    if (carried) {
      this.log(chalk.dim('  The old secrets.json.enc + .key are still there, untouched. Remove them'));
      this.log(chalk.dim('  once you have confirmed things work: vops keyring drop-legacy\n'));
    }
  }

  /** Copying alone changes nothing about the exposure (the file still has the values
   * and still wins) — the prune is what the user is really here for. */
  private importEnv(prune: boolean): void {
    const plan = planEnvImport();
    if (!plan.entries.length) return;

    const store = new LocalConfigStore();
    store.setEnv(readEnvValues(plan));
    const names = plan.entries.map((e) => e.name);
    const secrets = plan.entries.filter((e) => e.kind === 'secret').map((e) => e.name);

    this.log(chalk.green(`\n✓ Adopted ${names.length} variable(s) from ${plan.file}`));
    if (secrets.length) this.log(`  Secret values: ${secrets.join(', ')}`);

    if (!prune) {
      this.log(chalk.yellow(`  ! They are still in plaintext there, and .env still wins.`));
      this.log(chalk.dim(`    Remove them with: vops keyring import-env --prune`));
      return;
    }
    const { removed, backup } = pruneEnvFile(plan.file, names);
    this.log(`  Removed ${removed.length} line(s) from the plaintext file.`);
    this.log(chalk.dim(`  Backup: ${backup}`));
  }
}
