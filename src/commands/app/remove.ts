import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { approvalPending } from '../../safety/approval-gate';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { installHostFlag } from '../../apps/deploy-flags';

export default class AppRemove extends Command {
  static readonly description =
    'Remove a deployed app (units, containers, network). Volumes and secrets are KEPT ' +
    'unless --purge, so a later reinstall reuses the data.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> it-tools --yes',
    '<%= config.bin %> <%= command.id %> uptime-kuma --purge --yes',
    '<%= config.bin %> <%= command.id %> gitea --host web1 --yes',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    ...installHostFlag,
    purge: Flags.boolean({ default: false, description: 'Also delete volumes and secrets (destroys data)' }),
    yes: Flags.boolean({ default: false, description: 'Confirm removal' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppRemove);
    await runAgentCommand(
      this,
      'vops app remove',
      flags.json,
      () =>
        withService(VopsAppsService, async (svc) => {
          if (flags.yes) return { data: await svc.remove(args.name, { purge: flags.purge }, flags.host) };
          const plan = await svc.remove(args.name, { purge: flags.purge, dryRun: true }, flags.host);
          // The follow-up must carry --host: without it a re-run against a name that lives on two
          // hosts (or on a host that is gone) is refused, which is the state this command just read.
          const again = [args.name, `--host ${plan.host}`, ...(flags.purge ? ['--purge'] : [])].join(' ');
          return {
            data: plan,
            ...approvalPending({
              operation: plan.orphaned ? 'Forget app' : 'Remove app',
              target: `${args.name} on ${plan.host}`,
              consequence: consequenceOf(plan.orphaned, flags.purge),
            }),
            nextActions: [
              { command: `vops app remove ${again} --yes --json`, description: 'Remove it once the user has approved' },
            ],
          };
        }),
      (r) => this.render(args.name, flags.purge, r),
    );
  }

  private render(name: string, purge: boolean, r: { removed: boolean; purge: boolean; host: string; orphaned?: boolean }): void {
    if (!r.removed) {
      const purgeNote = purge ? chalk.red(' + delete volumes/secrets') : chalk.dim(' (volumes/secrets kept)');
      this.log(
        r.orphaned
          ? `Would forget ${chalk.bold(name)} — host ${r.host} is gone from inventory, so this only drops the local record`
          : `Would remove ${chalk.bold(name)} from ${r.host}` + purgeNote,
      );
      return;
    }
    if (r.orphaned) this.log(chalk.yellow(`✓ forgot ${name}`) + chalk.dim(' — host was missing; clean the server by hand if it still exists'));
    else this.log(chalk.green(`✓ removed ${name}`) + (r.purge ? chalk.dim(' (purged data)') : chalk.dim(' (data kept)')));
  }
}

function consequenceOf(orphaned: boolean | undefined, purge: boolean): string {
  if (orphaned) return 'The host is gone from inventory, so this only drops the local record.';
  return purge ? 'It deletes the volumes and secrets too — the data is not recoverable.' : 'Volumes and secrets are kept, so a reinstall reuses the data.';
}
