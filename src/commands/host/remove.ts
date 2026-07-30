import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostRemove extends Command {
  static readonly description = 'Forget a host (local inventory only; never touches the server)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostRemove);
    await runAgentCommand(
      this,
      'vops host remove',
      flags.json,
      async () => {
        await withService(VopsHostsService, (svc) => svc.remove(args.name));
        return { data: { removed: args.name } };
      },
      (r) => this.log(chalk.green(`✓ Forgot host '${r.removed}' (the server was not touched)`)),
    );
  }
}
