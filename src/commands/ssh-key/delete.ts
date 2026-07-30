import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { assertApproved } from '../../safety/approval-gate';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyDelete extends Command {
  static readonly description = 'Delete a local SSH key (requires --yes)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> my-key --yes'];

  static readonly args = {
    name: Args.string({ description: 'Key name', required: true }),
  };

  static readonly flags = {
    yes: Flags.boolean({ description: 'Confirm deletion', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SshKeyDelete);
    await runAgentCommand(
      this,
      'vops ssh-key delete',
      flags.json,
      async () => {
        assertApproved({
          operation: 'Delete SSH key',
          target: args.name,
          approved: flags.yes,
          consequence: 'The private key is deleted locally; anything that still trusts it stays reachable only by other keys.',
        });
        await withService(VopsSshKeysService, (svc) => svc.remove(args.name));
        return { data: { deleted: args.name } };
      },
      (res) => this.log(chalk.green(`✓ Deleted local SSH key '${res.deleted}'`)),
    );
  }
}
