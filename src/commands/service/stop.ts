import { Command } from '@oclif/core';
import * as path from 'node:path';
import chalk from 'chalk';
import { requireBackend, resolveContext } from '../../service/index';

export default class ServiceStop extends Command {
  static readonly description = 'Stop the background service (it comes back at your next login unless uninstalled)';

  async run(): Promise<void> {
    const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });
    requireBackend().stop(ctx);
    this.log(chalk.green('\n✓ Background service stopped.') + chalk.dim(' Remove it for good: vops service uninstall\n'));
  }
}
