import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsIngressService } from '../../apps/vops-ingress.service';

export default class IngressStatus extends Command {
  static readonly description = 'Show the vops ingress state on a host: Traefik container, health, and live routes.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    host: Args.string({ description: 'Inventory host name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IngressStatus);
    await runAgentCommand(
      this,
      'vops ingress status',
      flags.json,
      async () => {
        const r = await withService(VopsIngressService, (svc) => svc.status(args.host));
        const unhealthy = r.installed && (!r.active || r.health !== 200);
        return {
          data: r,
          warnings: unhealthy
            ? [{ code: 'INGRESS_UNHEALTHY', message: `ingress on ${r.host} is ${r.active ? 'active but not answering' : 'inactive'}`, path: r.host }]
            : [],
          nextActions: r.installed
            ? []
            : [{ command: `vops ingress up ${args.host} --email you@example.com`, description: 'No ingress yet — install it to expose apps on a domain' }],
        };
      },
      (r) => {
        if (!r.installed) {
          this.log(chalk.dim(`ingress not installed on ${r.host} — run \`vops ingress up ${r.host} --email you@example.com\`.`));
          return;
        }
        const healthy = r.active && r.health === 200;
        const degraded = r.active ? 'unhealthy' : 'inactive';
        const badge = healthy ? chalk.green('active') : chalk.yellow(degraded);
        this.log(`${chalk.bold(r.host)}  ingress: ${badge}` + chalk.dim(`  ping ${r.health}`));
        if (r.container) this.log(chalk.dim(`  ${r.container}`));
        this.log(chalk.dim(`  routes: ${r.routes.length ? r.routes.join(', ') : '(none)'}`));
      },
    );
  }
}
