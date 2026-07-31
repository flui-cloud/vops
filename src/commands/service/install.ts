import { Command, Flags } from '@oclif/core';
import * as path from 'node:path';
import chalk from 'chalk';
import { requireBackend, resolveContext } from '../../service/index';
import { statusLines } from '../../service/service-report';

export default class ServiceInstall extends Command {
  static readonly description =
    'Install the background service so the vops dashboard and metrics collector are always running';

  static readonly examples = ['<%= config.bin %> service install', '<%= config.bin %> service install --port 7799'];

  static readonly flags = {
    port: Flags.integer({ description: 'Port the service should serve on (default 7788)' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServiceInstall);
    const ctx = resolveContext({
      binRun: path.join(this.config.root, 'bin', 'run'),
      ...(flags.port ? { port: flags.port } : {}),
    });
    const status = requireBackend().install(ctx);

    this.log(chalk.green('\n✓ Background service installed and started.'));
    for (const line of statusLines(status)) this.log(line);
    this.log(
      chalk.dim(
        `\n  The dashboard now answers on http://127.0.0.1:${ctx.port} without you starting it.\n` +
          `  Remove it any time: vops service uninstall\n`,
      ),
    );
  }
}
