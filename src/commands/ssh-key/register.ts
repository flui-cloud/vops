import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SshKeyRegister);
    await runAgentCommand(
      this,
      'vops ssh-key register',
      flags.json,
      async () => {
        const result = await withService(VopsSshKeysService, (svc) => svc.register(flags.provider, args.name));
        return { data: { name: args.name, ...result } };
      },
      (res) => {
        this.log(chalk.green(`✓ Registered '${res.name}' on ${flags.provider} → key id ${res.providerKeyId}`));
        this.log(chalk.dim('  Use this id as --ssh-key when creating a server.'));
      },
    );
  }
}
