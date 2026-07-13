import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServersCreate);
    try {
      const plan = readPlanFile(flags['from-plan']);
      const outcome = await (await getVopsApp())
        .get(VopsServersService)
        .create(plan, { dryRun: flags['dry-run'], yes: flags.yes });

      if (flags.json) {
        this.log(JSON.stringify(outcome, null, 2));
        return;
      }

      if (outcome.dryRun) {
        this.log(
          chalk.yellow(
            `DRY RUN — would create ${plan.plan} in ${plan.location} (${plan.name}). Nothing changed.`,
          ),
        );
        return;
      }
      if (outcome.guided) {
        this.log(chalk.cyan('How to create (vops does not provision this provider):'));
        for (const line of outcome.howTo ?? []) this.log(chalk.dim(`  • ${line}`));
        return;
      }
      this.log(
        chalk.green(
          `✓ Created ${outcome.server?.id} (${outcome.server?.status}) ip=${outcome.server?.ip ?? 'pending'}`,
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
