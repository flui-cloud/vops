import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { installHostFlag } from '../../apps/deploy-flags';

export default class AppStatus extends Command {
  static readonly description = 'Show the live status of a deployed app (systemd units + containers).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> it-tools',
    '<%= config.bin %> <%= command.id %> it-tools --host web1',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = { ...installHostFlag, ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppStatus);
    await runAgentCommand(
      this,
      'vops app status',
      flags.json,
      async () => {
        const st = await withService(VopsAppsService, (svc) => svc.status(args.name, flags.host));
        const down = st.units.filter((u) => u.active !== 'active');
        return {
          data: st,
          warnings: down.map((u) => ({ code: 'APP_UNIT_NOT_ACTIVE', message: `${u.service} is ${u.active || 'unknown'}`, path: u.service })),
          nextActions: down.length
            ? [{ command: `vops app logs ${args.name} --host ${st.install.host} --json`, description: 'Read why the unit is not active' }]
            : [],
        };
      },
      (st) => {
        this.log(chalk.bold(st.install.name) + chalk.dim(`  on ${st.install.host} · ${st.install.appId}`));
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
        for (const c of st.containers) this.log(chalk.dim(`  ${c}`));
        for (const e of st.install.endpoints) this.log(`  endpoint: ${chalk.cyan(e.url)}`);
      },
    );
  }
}
