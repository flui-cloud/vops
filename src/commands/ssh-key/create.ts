import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyCreate extends Command {
  static readonly description =
    'Generate a local SSH keypair (private key never leaves this machine)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> my-key'];

  static readonly args = {
    name: Args.string({ description: 'Key name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SshKeyCreate);
    await runAgentCommand(
      this,
      'vops ssh-key create',
      flags.json,
      async () => ({ data: await withService(VopsSshKeysService, (svc) => svc.create(args.name)) }),
      (key) => {
        this.log(chalk.green(`✓ Created SSH key '${key.name}'`));
        this.log(chalk.dim(`  private: ${key.privateKeyPath} (stays on this machine)`));
        this.log(chalk.dim(`  fingerprint: ${key.fingerprint}`));
        this.log(`\n${key.publicKey}`);
      },
    );
  }
}
