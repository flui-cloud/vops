import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { ingressDeployFlags, runDeploy } from '../../apps/cli-deploy';

export default class AppInstall extends Command {
  static readonly description =
    'Install a bundled catalog app on a host (rootful Podman + Quadlet over SSH). ' +
    'Without --yes it runs the preflight and prints the full plan.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> it-tools --host web1',
    '<%= config.bin %> <%= command.id %> uptime-kuma --host web1 --yes',
    '<%= config.bin %> <%= command.id %> it-tools --host web1 --name tools --dry-run',
  ];

  static readonly args = {
    id: Args.string({ description: 'Catalog app id (see: vops app catalog)', required: true }),
  };

  static readonly flags = {
    host: Flags.string({ description: 'Target inventory host', required: true }),
    name: Flags.string({ description: 'Install name (defaults to the app id)' }),
    set: Flags.string({ multiple: true, description: 'Override an env/secret value: KEY=value' }),
    ...ingressDeployFlags,
    yes: Flags.boolean({ default: false, description: 'Actually deploy (otherwise plan only)' }),
    'dry-run': Flags.boolean({ default: false, description: 'Render the plan and stop' }),
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppInstall);
    try {
      const svc = (await getVopsApp()).get(VopsAppsService);
      await runDeploy(this, svc, { catalog: args.id }, flags);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
