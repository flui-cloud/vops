import { Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsAppsService } from '../../apps/vops-apps.service';
import { renderDeploy } from '../../apps/cli-deploy';
import { deployBody, imageDeployFlags, ingressDeployFlags } from '../../apps/deploy-flags';

export default class AppDeploy extends Command {
  static readonly description =
    'Deploy an app from a flui.yaml manifest to a host (rootful Podman + Quadlet over SSH). '
    + 'A kind: Application manifest is built from your repository, so pass --image; vops never builds. ' +
    'Without --yes it runs the preflight and prints the full plan.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> -f ./flui.yaml --host web1',
    '<%= config.bin %> <%= command.id %> -f ./flui.yaml --host web1 --yes',
    '<%= config.bin %> <%= command.id %> -f ./flui.yaml --host web1 --image ghcr.io/me/app:abc1234 --yes',
  ];

  static readonly flags = {
    file: Flags.string({ char: 'f', description: 'Path to a flui.yaml manifest', required: true }),
    host: Flags.string({ description: 'Target inventory host', required: true }),
    name: Flags.string({ description: 'Install name (defaults to metadata.id)' }),
    set: Flags.string({ multiple: true, description: 'Override an env/secret value: KEY=value' }),
    ...imageDeployFlags,
    ...ingressDeployFlags,
    yes: Flags.boolean({ default: false, description: 'Actually deploy (otherwise plan only)' }),
    'dry-run': Flags.boolean({ default: false, description: 'Render the plan and stop' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AppDeploy);
    await runAgentCommand(
      this,
      'vops app deploy',
      flags.json,
      () => withService(VopsAppsService, (svc) => deployBody(svc, { file: flags.file }, flags)),
      (view) => renderDeploy(this, view),
    );
  }
}
