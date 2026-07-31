import { Command } from '@oclif/core';
import * as path from 'node:path';
import chalk from 'chalk';
import { requireBackend, resolveContext } from '../../service/index';

export default class ServiceUninstall extends Command {
  static readonly description = 'Stop the background service and remove it from login';

  async run(): Promise<void> {
    const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });
    const { removed, unitPath } = requireBackend().uninstall(ctx);
    this.log(
      removed
        ? chalk.green('\n✓ Background service removed.') + chalk.dim(`\n  Was: ${unitPath}\n`)
        : chalk.dim('\nNo background service was installed.\n'),
    );
  }
}
