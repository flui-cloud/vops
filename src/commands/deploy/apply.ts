import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { VopsAgentApiService } from '../../agent-api/vops-agent-api.service';
import { DeployResult } from '../../apps/vops-apps.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { registryFromFlags } from '../../apps/deploy-flags';

export default class DeployApply extends Command {
  static readonly description =
    'Deploy an approved plan by id. Persistent change: exits 5 without --yes, and exits 3 if the manifest ' +
    'or the host no longer produces the plan that was approved.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> --plan 3f9a12c40b7e --yes --json'];

  static readonly flags = {
    plan: Flags.string({ required: true, description: 'Plan id from `vops deploy plan`' }),
    project: Flags.string({ default: '.', description: 'Project root (where .vops lives)' }),
    yes: Flags.boolean({ default: false, description: 'The user approved this plan' }),
    'registry-user': Flags.string({ description: 'Registry username, when the image is private' }),
    'registry-token': Flags.string({ description: 'Registry token with read access to packages. Supplied here, never stored in the plan.', env: 'VOPS_REGISTRY_TOKEN' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DeployApply);
    try {
      const svc = (await getVopsApp()).get(VopsAgentApiService);
      await runAgentCommand(
        this,
        'vops deploy apply',
        flags.json,
        async () => {
          const data = await svc.apply(flags.project, flags.plan, flags.yes, registryFromFlags(flags));
          return {
            data,
            warnings: (data.warnings ?? []).map((message) => ({ code: 'VOPS_DEPLOY_ADVISORY', message })),
            nextActions: [{ command: `vops deploy verify --app ${data.app} --json`, description: 'Verify before reporting success' }],
          };
        },
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function render(cmd: Command, r: DeployResult): void {
  cmd.log(chalk.green('✓ deployed ') + chalk.bold(r.app) + chalk.dim(`  on ${r.host}`));
  for (const c of r.components) cmd.log(chalk.dim(`  ${c.name}: ${c.image}`));
  for (const e of r.endpoints) {
    const reach = chalk.dim(`(${e.reach ?? 'public'})`);
    cmd.log(`  endpoint: ${chalk.cyan(e.url)} ${reach}`);
  }
  if (r.ingress) cmd.log(`  ${chalk.magenta('ingress:')} ${chalk.cyan((r.ingress.tls ? 'https://' : 'http://') + r.ingress.hostname)}`);
  cmd.log(chalk.dim(`  smoke: ${r.smoke}`));
  for (const w of r.warnings ?? []) cmd.log(chalk.yellow(`  ! ${w}`));
  cmd.log(chalk.dim(`\n  verify it: vops deploy verify --app ${r.app}`));
}
