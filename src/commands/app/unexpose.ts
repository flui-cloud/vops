import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsAppsService } from '../../apps/vops-apps.service';

export default class AppUnexpose extends Command {
  static readonly description =
    'Detach an app from the ingress: drop its Traefik route + auto A-record and rebind its port to ' +
    '0.0.0.0 (recreates the container). The app stays deployed, reachable on its direct high port.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> tools --yes'];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    yes: Flags.boolean({ default: false, description: 'Actually detach (recreates the container on 0.0.0.0)' }),
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppUnexpose);
    try {
      if (!flags.yes) this.error('Re-run with --yes to detach ingress (this recreates the container on 0.0.0.0).', { exit: 1 });
      const svc = (await getVopsApp()).get(VopsAppsService);
      const r = await svc.unexpose(args.name);
      if (flags.json) {
        this.log(JSON.stringify(r, null, 2));
        return;
      }
      this.log(chalk.green(`✓ detached ${chalk.bold(r.app)} from ingress`));
      for (const e of r.endpoints) this.log(`  endpoint: ${chalk.cyan(e.url)} ${chalk.dim('(' + e.component + ')')}`);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
