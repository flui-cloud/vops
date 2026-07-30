import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { installHostFlag } from '../../apps/deploy-flags';

export default class AppRestart extends Command {
  static readonly description = 'Restart a deployed app’s containers (a quick recovery action — units, images and secrets are untouched).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> it-tools',
    '<%= config.bin %> <%= command.id %> it-tools --host web1',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = { ...installHostFlag, ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppRestart);
    await runAgentCommand(
      this,
      'vops app restart',
      flags.json,
      async () => {
        const st = await withService(VopsAppsService, (svc) => svc.restart(args.name, flags.host));
        const down = st.units.filter((u) => u.active !== 'active');
        return {
          data: st,
          warnings: down.map((u) => ({ code: 'APP_UNIT_NOT_ACTIVE', message: `${u.service} is ${u.active || 'unknown'}`, path: u.service })),
          nextActions: down.length
            ? [{ command: `vops app logs ${args.name} --host ${st.install.host} --json`, description: 'Read why the unit did not come back up' }]
            : [],
        };
      },
      (st) => {
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
      },
    );
  }
}
