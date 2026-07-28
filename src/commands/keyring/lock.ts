import { Command } from '@oclif/core';
import chalk from 'chalk';
import { lockKeyring } from '../../lib/keyring/unlock';
import { profileDir } from '../../lib/profile';

export default class KeyringLock extends Command {
  static readonly description = 'Forget the vault key: the keyring wipes it and exits';

  async run(): Promise<void> {
    const locked = await lockKeyring(profileDir());
    this.log(
      locked
        ? chalk.green('\n✓ Locked. The keyring wiped the key and is shutting down.\n')
        : chalk.dim('\nNothing to lock — no keyring was running.\n'),
    );
  }
}
