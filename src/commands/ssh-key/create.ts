import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyCreate extends Command {
  static readonly description =
    'Generate a local SSH keypair (private key never leaves this machine)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> my-key'];

  static readonly args = {
    name: Args.string({ description: 'Key name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SshKeyCreate);
    try {
      const key = (await getVopsApp()).get(VopsSshKeysService).create(args.name);
      if (flags.json) {
        this.log(JSON.stringify(key, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Created SSH key '${key.name}'`));
      this.log(chalk.dim(`  private: ${key.privateKeyPath} (stays on this machine)`));
      this.log(chalk.dim(`  fingerprint: ${key.fingerprint}`));
      this.log(`\n${key.publicKey}`);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
