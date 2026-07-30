import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../../lib/cloud-client';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';

export default class WatchUptimeRemove extends Command {
  static readonly description = 'Remove an uptime monitor';

  static readonly examples = ['<%= config.bin %> <%= command.id %> <id>'];

  static readonly args = {
    id: Args.string({ description: 'Monitor id', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchUptimeRemove);
    await runAgentCommand(
      this,
      'vops watch uptime remove',
      flags.json,
      async () => {
        await new CloudClient().removeUptime(args.id);
        return { data: { removed: args.id } };
      },
      (res) => this.log(`${chalk.green('✓')} Removed uptime monitor ${res.removed}`),
    );
  }
}
