import { Command } from '@oclif/core';
import * as path from 'node:path';
import chalk from 'chalk';
import { requireBackend, resolveContext } from '../../service/index';

export default class ServiceStart extends Command {
  static readonly description = 'Start the background service without reinstalling it';

  async run(): Promise<void> {
    const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });
    requireBackend().start(ctx);
    this.log(chalk.green(`\n✓ Background service started on http://127.0.0.1:${ctx.port}\n`));
  }
}
