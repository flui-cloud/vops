import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsAppsService } from '../../apps/vops-apps.service';

export default class AppPreflight extends Command {
  static readonly description = 'Check whether a host is ready to run flui.yaml apps (podman/quadlet, k3s coexistence).';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    host: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppPreflight);
    await runAgentCommand(
      this,
      'vops app preflight',
      flags.json,
      async () => {
        const pf = await withService(VopsAppsService, (svc) => svc.preflight(args.host));
        return {
          // listeningPorts is a Set — spread it or JSON.stringify emits {}.
          data: { ...pf, facts: { ...pf.facts, listeningPorts: [...pf.facts.listeningPorts] } },
          warnings: pf.issues.map((message) => ({ code: 'HOST_NOT_READY', message, path: pf.host })),
          nextActions: pf.ready
            ? []
            : [{ command: `vops app setup --host ${args.host}`, description: 'Install Podman 5 + Quadlet on this host' }],
        };
      },
      (data) => {
        const f = data.facts;
        this.log(chalk.bold(data.host) + (data.ready ? chalk.green('  ready') : chalk.yellow('  not ready')));
        this.log(`  podman: ${f.podmanVersion ?? chalk.red('not installed')}`);
        this.log(`  quadlet: ${f.quadletGenerator ? chalk.green('yes') : chalk.red('no')}`);
        this.log(`  k3s: ${f.k3s ? chalk.yellow('active → coexistence mode') : chalk.dim('none')}`);
        this.log(chalk.dim(`  selinux: ${f.selinux ? 'yes' : 'no'} · arch ${f.arch} · free ${Math.round(f.freeKb / 1024)} MiB`));
        for (const issue of data.issues) this.log(chalk.yellow(`  ! ${issue}`));
      },
    );
  }
}
