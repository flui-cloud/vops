import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../lib/cloud-client';

export default class WatchRemove extends Command {
  static readonly description = 'Delete a watch (and its channel secrets) by id';

  static readonly args = {
    id: Args.string({ description: 'Watch id (from `vops watch list`)', required: true }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(WatchRemove);
    try {
      await new CloudClient().removeWatch(args.id);
      this.log(`${chalk.green('✓')} Removed watch ${chalk.dim(args.id)}`);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}
