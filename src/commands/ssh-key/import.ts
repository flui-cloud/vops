import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyImport extends Command {
  static readonly description =
    'Import an SSH key you already use — the private key is referenced, never copied';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> laptop --from ~/.ssh/id_ed25519',
    '<%= config.bin %> <%= command.id %> deploy --pub ~/.ssh/deploy.pub',
    '<%= config.bin %> <%= command.id %> ci --public-key "ssh-ed25519 AAAA..."',
  ];

  static readonly args = {
    name: Args.string({ description: 'Local key name to store it under', required: true }),
  };

  static readonly flags = {
    from: Flags.string({
      description: 'Path to an existing PRIVATE key you already use (referenced, not copied)',
    }),
    pub: Flags.string({ description: 'Path to an existing PUBLIC key file' }),
    'public-key': Flags.string({ description: 'A public key pasted directly' }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SshKeyImport);
    try {
      const key = (await getVopsApp()).get(VopsSshKeysService).import(args.name, {
        privateKeyPath: flags.from,
        publicKeyPath: flags.pub,
        publicKey: flags['public-key'],
      });
      if (flags.json) {
        this.log(JSON.stringify(key, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Imported '${key.name}' (${key.fingerprint})`));
      this.log(
        chalk.dim(
          key.hasPrivateKey
            ? `  Private key referenced at ${key.privateKeyPath} — usable for 'vops ssh'.`
            : '  Public-only import — registerable to a provider, but not usable for direct SSH.',
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
