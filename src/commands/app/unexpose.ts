import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { approvalRequired } from '../../safety/approval-gate';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { installHostFlag } from '../../apps/deploy-flags';

/** One wording for the bind, used by the description, the flag and the refusal: three copies of
 * this sentence drift from the code. */
const BIND_NOTE =
  'A --public install goes back to 0.0.0.0; a default install stays on 127.0.0.1, reachable only from the host itself (SSH tunnel, or re-expose it with a domain).';

export default class AppUnexpose extends Command {
  static readonly description =
    'Detach an app from the ingress: drop its Traefik route + auto A-record and rebind its port to the ' +
    `bind it was installed with (recreates the container). The app stays deployed. ${BIND_NOTE}`;

  static readonly examples = ['<%= config.bin %> <%= command.id %> tools --yes'];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    ...installHostFlag,
    yes: Flags.boolean({ default: false, description: `Actually detach (recreates the container). ${BIND_NOTE}` }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppUnexpose);
    await runAgentCommand(
      this,
      'vops app unexpose',
      flags.json,
      async () => {
        if (!flags.yes) {
          throw approvalRequired({
            operation: 'Detach ingress',
            target: args.name,
            approved: false,
            consequence: `This drops the route + A-record and recreates the container. ${BIND_NOTE}`,
          });
        }
        const data = await withService(VopsAppsService, (svc) => svc.unexpose(args.name, flags.host));
        return { data, nextActions: [{ command: `vops app status ${data.app} --host ${data.host} --json`, description: 'Confirm the app is still up on its direct port' }] };
      },
      (r) => {
        this.log(chalk.green(`✓ detached ${chalk.bold(r.app)} from ingress`));
        for (const e of r.endpoints) this.log(`  endpoint: ${chalk.cyan(e.url)} ${chalk.dim('(' + e.component + ')')}`);
      },
    );
  }
}
