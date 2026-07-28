import { Command } from '@oclif/core';
import chalk from 'chalk';
import { ensureVaultUnlocked } from '../../lib/keyring/unlock';
import { requireVaultKey } from '../../lib/keyring/vault-session';
import { LEGACY_ENC_FILE, dropLegacy, legacyExists, vaultExists } from '../../lib/keyring/vault-store';
import { profileDir } from '../../lib/profile';

export default class KeyringDropLegacy extends Command {
  static readonly description = 'Delete the old secrets.json.enc + .key, once the vault is proven readable';

  async run(): Promise<void> {
    const dir = profileDir();
    if (!vaultExists(dir)) this.error('This profile is not sealed. Run: vops keyring init', { exit: 1 });
    if (!legacyExists(dir)) {
      this.log(chalk.dim(`\nNothing to remove — no ${LEGACY_ENC_FILE} in this profile.\n`));
      return;
    }

    // dropLegacy re-reads the vault with this key first and refuses if it fails,
    // so there is no moment where neither copy of the tokens is readable.
    await ensureVaultUnlocked({ dir });
    dropLegacy(dir, requireVaultKey());
    this.log(chalk.green('\n✓ Removed the old key file and encrypted store.\n'));
  }
}
