import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsServersService } from '../../servers/vops-servers.service';

export default class ServersDelete extends Command {
  static readonly description = 'Delete a server (requires --yes)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 12345 --provider hetzner --yes',
  ];

  static readonly args = {
    id: Args.string({ description: 'Server id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | ovh', required: true }),
    yes: Flags.boolean({ description: 'Confirm deletion', default: false }),
    force: Flags.boolean({ description: 'Delete even if running', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ServersDelete);
    try {
      if (!flags.yes) {
        this.error(
          `Refusing to delete ${args.id} without confirmation. Re-run with --yes.`,
          { exit: 1 },
        );
      }
      await (await getVopsApp())
        .get(VopsServersService)
        .delete(flags.provider, args.id, flags.force);

      if (flags.json) {
        this.log(JSON.stringify({ deleted: args.id }, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Deletion requested for ${args.id}.`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
