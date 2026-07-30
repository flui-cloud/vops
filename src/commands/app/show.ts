import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { installHostFlag } from '../../apps/deploy-flags';

export default class AppShow extends Command {
  static readonly description = 'Show the stored record of a deployed app install.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> it-tools',
    '<%= config.bin %> <%= command.id %> it-tools --host web1',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = { ...installHostFlag, ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppShow);
    await runAgentCommand(
      this,
      'vops app show',
      flags.json,
      async () => {
        const install = await withService(VopsAppsService, (svc) => svc.show(args.name, flags.host));
        return {
          data: install,
          nextActions: [
            { command: `vops app status ${args.name} --host ${install.host} --json`, description: 'Whether it is actually running right now' },
            { command: `vops app logs ${args.name} --host ${install.host} --json`, description: 'Recent journald output' },
          ],
        };
      },
      (i) => {
        this.log(chalk.bold(i.name) + chalk.dim(`  ${i.appId} · ${i.kind} · ${i.mode}`));
        this.log(chalk.dim(`host ${i.host} · deployed ${i.status} · updated ${i.updatedAt}`));
        for (const c of i.components) {
          const ports = c.published.map((p) => `${p.host}→${p.container}`).join(', ') || chalk.dim('internal');
          this.log(`  ${chalk.bold(c.name)} ${chalk.dim(c.image)}  ${ports}`);
        }
        for (const e of i.endpoints) this.log(`  endpoint: ${chalk.cyan(e.url)}`);
        if (i.volumes.length) this.log(chalk.dim(`  volumes: ${i.volumes.join(', ')}`));
      },
    );
  }
}
