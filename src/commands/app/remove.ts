import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsAppsService } from '../../apps/vops-apps.service';

export default class AppRemove extends Command {
  static readonly description =
    'Remove a deployed app (units, containers, network). Volumes and secrets are KEPT ' +
    'unless --purge, so a later reinstall reuses the data.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> it-tools --yes',
    '<%= config.bin %> <%= command.id %> uptime-kuma --purge --yes',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    purge: Flags.boolean({ default: false, description: 'Also delete volumes and secrets (destroys data)' }),
    yes: Flags.boolean({ default: false, description: 'Confirm removal' }),
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppRemove);
    try {
      const svc = (await getVopsApp()).get(VopsAppsService);
      if (!flags.yes) {
        const plan = await svc.remove(args.name, { purge: flags.purge, dryRun: true });
        const purgeNote = flags.purge ? chalk.red(' + delete volumes/secrets') : chalk.dim(' (volumes/secrets kept)');
        this.log(
          plan.orphaned
            ? `Would forget ${chalk.bold(args.name)} — host ${plan.host} is gone from inventory, so this only drops the local record`
            : `Would remove ${chalk.bold(args.name)} from ${plan.host}` + purgeNote,
        );
        this.error('Refusing to remove without confirmation. Re-run with --yes.', { exit: 1 });
      }
      const res = await svc.remove(args.name, { purge: flags.purge });
      if (flags.json) this.log(JSON.stringify(res, null, 2));
      else if (res.orphaned) this.log(chalk.yellow(`✓ forgot ${args.name}`) + chalk.dim(` — host was missing; clean the server by hand if it still exists`));
      else this.log(chalk.green(`✓ removed ${args.name}`) + (res.purge ? chalk.dim(' (purged data)') : chalk.dim(' (data kept)')));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
