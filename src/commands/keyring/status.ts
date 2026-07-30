import { Command } from '@oclif/core';
import chalk from 'chalk';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { keyringStatus } from '../../lib/keyring/unlock';
import { planEnvImport } from '../../lib/keyring/env-import';
import { legacyExists, vaultExists, vaultPath } from '../../lib/keyring/vault-store';
import { profileDir } from '../../lib/profile';

export default class KeyringStatus extends Command {
  static readonly description = 'Show whether this profile is sealed, and whether the keyring is unlocked';

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(KeyringStatus);
    await runAgentCommand(
      this,
      'vops keyring status',
      flags.json,
      async () => {
        const dir = profileDir();
        return {
          data: {
            profileDir: dir,
            vault: vaultExists(dir) ? vaultPath(dir) : null,
            legacyStore: legacyExists(dir),
            plaintextEnv: planEnvImport().entries.map((e) => e.name),
            keyring: await keyringStatus(dir),
          },
        };
      },
      (state) => {
        if (state.vault) {
          this.log(chalk.green(`\n  Sealed:   ${state.vault}`));
          this.log(`  Keyring:  ${describe(state.keyring)}`);
        } else {
          this.log(chalk.yellow('\n  Not sealed.') + chalk.dim(' Secrets are encrypted with a key file stored beside them.'));
          this.log(chalk.dim('  Derive the key from a passphrase instead: vops keyring init\n'));
        }

        if (state.legacyStore) {
          this.log(chalk.dim('  Legacy:   secrets.json.enc + .key still present (vops keyring drop-legacy)'));
        }
        if (state.plaintextEnv.length) {
          this.log(
            chalk.yellow(`  Plaintext: ${state.plaintextEnv.length} credential(s) still in .env`) +
              chalk.dim(' — vops keyring import-env --prune'),
          );
        }
        this.log('');
      },
    );
  }
}

function describe(keyring: { listening: boolean; unlocked: boolean; expiresAt: number | null }): string {
  if (!keyring.listening) return chalk.dim('not running (the next command that needs a secret will start it)');
  if (!keyring.unlocked) return chalk.yellow('running, locked');
  const left = keyring.expiresAt ? Math.max(0, Math.round((keyring.expiresAt - Date.now()) / 60_000)) : null;
  return chalk.green('unlocked') + (left === null ? '' : chalk.dim(` (${left} min left)`));
}
