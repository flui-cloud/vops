import { Command } from '@oclif/core';
import chalk from 'chalk';
import { ensureVaultUnlocked, keyringStatus } from '../../lib/keyring/unlock';
import { vaultExists } from '../../lib/keyring/vault-store';
import { profileDir } from '../../lib/profile';

export default class KeyringUnlock extends Command {
  static readonly description = 'Unlock the vault for this session (starts the keyring if needed)';

  async run(): Promise<void> {
    const dir = profileDir();
    if (!vaultExists(dir)) {
      this.error('This profile is not sealed. Run: vops keyring init', { exit: 1 });
    }

    await ensureVaultUnlocked({ dir, useDaemon: true });
    const { listening, expiresAt } = await keyringStatus(dir);

    if (!listening) {
      // Local derivation worked, but nothing is holding the key for the next
      // command — say so rather than implying a session was established.
      this.log(chalk.yellow('\n✓ Passphrase accepted, but no keyring is running.'));
      this.log(chalk.dim('  Each command will ask again. See `vops keyring status`.\n'));
      return;
    }
    const minutes = expiresAt ? Math.round((expiresAt - Date.now()) / 60_000) : null;
    this.log(chalk.green('\n✓ Unlocked.') + chalk.dim(minutes === null ? '' : ` Stays open for ${minutes} min of inactivity.`));
    this.log(chalk.dim('  Lock it early with: vops keyring lock\n'));
  }
}
