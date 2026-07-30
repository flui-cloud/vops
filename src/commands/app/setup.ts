import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { approvalRequired } from '../../safety/approval-gate';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { PODMAN_STATIC_VERSION } from '../../apps/podman-bootstrap';

export default class AppSetup extends Command {
  static readonly description =
    `Install Podman ${PODMAN_STATIC_VERSION} (podman-static) on a host that lacks it, over SSH. ` +
    'Self-contained static build with Quadlet wired in — works on any distro, incl. Ubuntu 24.04.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1 --yes'];

  static readonly args = {
    host: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    yes: Flags.boolean({ default: false, description: 'Confirm the install' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSetup);
    await runAgentCommand(
      this,
      'vops app setup',
      flags.json,
      async () => {
        if (!flags.yes) {
          throw approvalRequired({
            operation: 'Install podman',
            target: args.host,
            approved: false,
            consequence: `It installs podman-static ${PODMAN_STATIC_VERSION} into /usr/local (verified SHA, Quadlet included).`,
          });
        }
        const data = await withService(VopsAppsService, (svc) => svc.setup(args.host));
        return {
          data,
          warnings: data.conflict
            ? [{ code: 'VOPS_PODMAN_GENERATOR_CONFLICT', message: 'A distro podman generator is also present in /usr/lib — remove the apt/dnf podman to avoid double-processed units.' }]
            : [],
        };
      },
      (r) => {
        this.log(chalk.green(`✓ podman ${r.version} installed on ${r.host}`) + chalk.dim(`  quadlet: ${r.quadlet ? 'yes' : 'no'}`));
        if (r.conflict) {
          this.log(chalk.yellow('! a distro podman generator is also present in /usr/lib — remove the apt/dnf podman to avoid double-processed units.'));
        }
      },
    );
  }
}
