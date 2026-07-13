import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetDelete extends Command {
  static readonly description = 'Delete a private network (--dry-run to preview, --yes to apply)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --yes',
  ];

  static readonly args = {
    id: Args.string({ description: 'Network id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    'dry-run': Flags.boolean({ description: 'Preview without deleting', default: false }),
    yes: Flags.boolean({ description: 'Confirm deletion', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetDelete);
    try {
      const outcome = await (await getVopsApp())
        .get(VopsVnetService)
        .delete(flags.provider, args.id, { dryRun: flags['dry-run'], yes: flags.yes });

      if (flags.json) {
        this.log(JSON.stringify({ id: args.id, ...outcome }, null, 2));
        return;
      }
      this.log(
        outcome.dryRun
          ? chalk.yellow(`DRY RUN: would delete network ${args.id}. Nothing changed.`)
          : chalk.green(`✓ Deleted network ${args.id}.`),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
