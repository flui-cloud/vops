import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../../lib/cloud-client';

export default class WatchUptimeRemove extends Command {
  static readonly description = 'Remove an uptime monitor';

  static readonly examples = ['<%= config.bin %> <%= command.id %> <id>'];

  static readonly args = {
    id: Args.string({ description: 'Monitor id', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchUptimeRemove);
    try {
      await new CloudClient().removeUptime(args.id);
      if (flags.json) {
        this.log(JSON.stringify({ removed: args.id }, null, 2));
        return;
      }
      this.log(`${chalk.green('✓')} Removed uptime monitor ${args.id}`);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}
