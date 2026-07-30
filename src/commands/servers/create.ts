import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { readPlanFile } from '../../lib/plan-io';
import { VopsServersService } from '../../servers/vops-servers.service';

export default class ServersCreate extends Command {
  static readonly description =
    'Create a server from a plan file (hourly-gated; requires --yes)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --from-plan ./vops-plan.json --dry-run',
    '<%= config.bin %> <%= command.id %> --from-plan ./vops-plan.json --yes',
  ];

  static readonly flags = {
    'from-plan': Flags.string({ description: 'Path to a vops.plan.v1 file', required: true }),
    'dry-run': Flags.boolean({ description: 'Validate only; create nothing', default: false }),
    yes: Flags.boolean({ description: 'Confirm real creation (billable)', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServersCreate);
    let planned = '';
    await runAgentCommand(
      this,
      'vops servers create',
      flags.json,
      async () => {
        const plan = readPlanFile(flags['from-plan']);
        planned = `${plan.plan} in ${plan.location} (${plan.name})`;
        return {
          data: await withService(VopsServersService, (svc) =>
            svc.create(plan, { dryRun: flags['dry-run'], yes: flags.yes }),
          ),
        };
      },
      (outcome) => {
        if (outcome.dryRun) {
          this.log(chalk.yellow(`DRY RUN — would create ${planned}. Nothing changed.`));
          return;
        }
        if (outcome.guided) {
          this.log(chalk.cyan('How to create (vops does not provision this provider):'));
          for (const line of outcome.howTo ?? []) this.log(chalk.dim(`  • ${line}`));
          return;
        }
        this.log(chalk.green(`✓ Created ${outcome.server?.id} (${outcome.server?.status}) ip=${outcome.server?.ip ?? 'pending'}`));
      },
    );
  }
}
