import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { renderDeploy } from '../../apps/cli-deploy';
import { deployBody, ingressDeployFlags } from '../../apps/deploy-flags';

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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppInstall);
    await runAgentCommand(
      this,
      'vops app install',
      flags.json,
      () => withService(VopsAppsService, (svc) => deployBody(svc, { catalog: args.id }, flags)),
      (view) => renderDeploy(this, view),
    );
  }
}
