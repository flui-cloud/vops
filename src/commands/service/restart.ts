import { Command } from '@oclif/core';
import * as path from 'node:path';
import chalk from 'chalk';
import { requireBackend, resolveContext } from '../../service/index';

export default class ServiceRestart extends Command {
  static readonly description = 'Restart the background service (picks up a new vops version)';

  async run(): Promise<void> {
    const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });
    requireBackend().restart(ctx);
    this.log(chalk.green('\n✓ Background service restarted.\n'));
  }
}
