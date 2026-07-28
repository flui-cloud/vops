import { Command, Flags } from '@oclif/core';
import { runKeyringDaemon } from '../../lib/keyring/daemon-main';
import { profileDir } from '../../lib/profile';

/** Normally unused — the first command needing a secret spawns `daemon-main.js`
 * directly. This lets it be run/watched like any process (debugger, service unit). */
export default class KeyringDaemon extends Command {
  static readonly description = 'Run the keyring in the foreground (normally started on demand)';
  static readonly hidden = true;

  static readonly flags = {
    ttl: Flags.integer({ description: 'Sliding lifetime of an unlock, in minutes' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(KeyringDaemon);
    const handle = await runKeyringDaemon(
      profileDir(),
      flags.ttl ? flags.ttl * 60_000 : undefined,
    );
    this.log(`keyring listening on ${handle.socketPath}`);
    await new Promise<void>(() => {});
  }
}
