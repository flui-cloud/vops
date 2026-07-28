import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsAppsService } from '../../apps/vops-apps.service';

export default class AppRestart extends Command {
  static readonly description = 'Restart a deployed app’s containers (a quick recovery action — units, images and secrets are untouched).';

  static readonly examples = ['<%= config.bin %> <%= command.id %> it-tools'];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppRestart);
    try {
      const svc = (await getVopsApp()).get(VopsAppsService);
      const st = await svc.restart(args.name);
      if (flags.json) {
        this.log(JSON.stringify(st, null, 2));
        return;
      }
      this.log(chalk.bold(st.install.name) + chalk.dim(`  restarted on ${st.install.host}`));
      this.log(
        renderTable(
          ['UNIT', 'ACTIVE', 'SUB'],
          st.units.map((u) => [
            u.service,
            u.active === 'active' ? chalk.green(u.active) : chalk.yellow(u.active || '—'),
            chalk.dim(u.sub || '—'),
          ]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
