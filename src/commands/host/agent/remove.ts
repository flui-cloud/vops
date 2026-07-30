import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsAgentService } from '../../../agent/vops-agent.service';

export default class HostAgentRemove extends Command {
  static readonly description = 'Remove the in-guest metrics agent from a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostAgentRemove);
    await runAgentCommand(
      this,
      'vops host agent remove',
      flags.json,
      async () => ({ data: await withService(VopsAgentService, (svc) => svc.remove(args.name)) }),
      (res) => this.log(chalk.green(`✓ Agent removed from '${res.host}'`)),
    );
  }
}
