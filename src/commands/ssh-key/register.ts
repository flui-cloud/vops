import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyRegister extends Command {
  static readonly description =
    'Upload a local key\'s PUBLIC half to a provider (private key stays local)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-key --provider contabo',
  ];

  static readonly args = {
    name: Args.string({ description: 'Local key name', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SshKeyRegister);
    try {
      const result = await (await getVopsApp())
        .get(VopsSshKeysService)
        .register(flags.provider, args.name);
      if (flags.json) {
        this.log(JSON.stringify({ name: args.name, ...result }, null, 2));
        return;
      }
      this.log(
        chalk.green(
          `✓ Registered '${args.name}' on ${flags.provider} → key id ${result.providerKeyId}`,
        ),
      );
      this.log(chalk.dim('  Use this id as --ssh-key when creating a server.'));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
