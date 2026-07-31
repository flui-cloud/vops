import { Command } from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { requireBackend, resolveContext } from '../../service/index';

const TAIL_LINES = 60;

export default class ServiceLogs extends Command {
  static readonly description = 'Show where the background service writes its logs, and the last lines of them';

  async run(): Promise<void> {
    const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });
    const backend = requireBackend();
    this.log(chalk.dim(`\n  Follow: ${backend.logHint(ctx)}\n`));

    // systemd keeps its own journal, so there may be no file to read here.
    if (!fs.existsSync(ctx.logPath)) {
      this.log(chalk.dim(`  No log file at ${ctx.logPath} — use the command above.\n`));
      return;
    }
    const lines = fs.readFileSync(ctx.logPath, 'utf8').split('\n').slice(-TAIL_LINES);
    for (const line of lines) this.log('  ' + line);
    this.log('');
  }
}
