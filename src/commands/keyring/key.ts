import { Args, Command, Flags } from '@oclif/core';
import { COMPANION_NAMES } from '../../lib/keyring/companion';
import { companionKey } from '../../lib/keyring/unlock';
import { profileDir } from '../../lib/profile';

export default class KeyringKey extends Command {
  static readonly description =
    "Print a companion tool's key, derived from this profile's passphrase, so it can seal its own store without a second secret";

  static readonly examples = ['DYMMI_KEY=$(vops keyring key dymmi) dymmi serve'];

  static readonly args = {
    companion: Args.string({
      description: 'Companion tool to derive for',
      options: COMPANION_NAMES,
      required: true,
    }),
  };

  static readonly flags = {
    force: Flags.boolean({ description: 'Print even when stdout is a terminal', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KeyringKey);

    // Every other command treats printing a secret as a bug. Here it is the whole
    // point, so make the safe shape the default one: piped into the companion,
    // never left sitting in a scrollback.
    if (process.stdout.isTTY && !flags.force) {
      this.error(
        [
          'Refusing to print a key to a terminal, where it would stay in your scrollback.',
          `  Pipe it instead:  DYMMI_KEY=$(vops keyring key ${args.companion})`,
          '  Or override with: --force',
        ].join('\n'),
        { exit: 1 },
      );
    }

    const key = await companionKey(args.companion, profileDir());
    try {
      this.log(key.toString('hex'));
    } finally {
      key.fill(0);
    }
  }
}
