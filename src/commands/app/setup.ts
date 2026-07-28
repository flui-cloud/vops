import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
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
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSetup);
    try {
      if (!flags.yes) {
        this.log(
          `Would install podman-static ${PODMAN_STATIC_VERSION} into /usr/local on ${chalk.bold(args.host)} ` +
            `(verified SHA, Quadlet included).`,
        );
        this.error('Re-run with --yes to install.', { exit: 1 });
      }
      const svc = (await getVopsApp()).get(VopsAppsService);
      const r = await svc.setup(args.host);
      if (flags.json) {
        this.log(JSON.stringify(r, null, 2));
        return;
      }
      this.log(chalk.green(`✓ podman ${r.version} installed on ${r.host}`) + chalk.dim(`  quadlet: ${r.quadlet ? 'yes' : 'no'}`));
      if (r.conflict) {
        this.log(chalk.yellow('! a distro podman generator is also present in /usr/lib — remove the apt/dnf podman to avoid double-processed units.'));
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
