import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { assertApproved } from '../../safety/approval-gate';
import { DeleteOutcome, VopsServersService } from '../../servers/vops-servers.service';

export default class ServersDelete extends Command {
  static readonly description =
    'Delete a server (requires --yes); also forgets its local inventory entry and stale host key';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 12345 --provider hetzner --yes',
  ];

  static readonly args = {
    id: Args.string({ description: 'Server id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | ovh | cherry', required: true }),
    yes: Flags.boolean({ description: 'Confirm deletion', default: false }),
    force: Flags.boolean({ description: 'Delete even if running', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ServersDelete);
    await runAgentCommand(
      this,
      'vops servers delete',
      flags.json,
      async () => {
        assertApproved({
          operation: 'Delete server',
          target: args.id,
          approved: flags.yes,
          consequence: 'The server and everything on it are destroyed.',
        });
        const data = await withService(VopsServersService, (svc) =>
          svc.delete(flags.provider, args.id, flags.force),
        );
        return {
          data,
          ...(data.warning
            ? { warnings: [{ code: 'VOPS_LOCAL_CLEANUP_INCOMPLETE', message: data.warning }] }
            : {}),
        };
      },
      (res) => this.render(res),
    );
  }

  private render(res: DeleteOutcome): void {
    this.log(chalk.green(`✓ Deletion requested for ${res.deleted}.`));
    if (res.forgotten.length > 0) {
      this.log(chalk.dim(`  forgot from the inventory: ${res.forgotten.join(', ')}`));
    }
    if (res.knownHostsPruned > 0) {
      this.log(chalk.dim(`  dropped ${res.knownHostsPruned} stale known_hosts entry(ies)`));
    }
    if (res.warning) this.log(chalk.yellow(`! ${res.warning}`));
  }
}
