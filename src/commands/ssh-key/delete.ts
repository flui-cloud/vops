import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyDelete extends Command {
  static readonly description = 'Delete a local SSH key (requires --yes)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> my-key --yes'];

  static readonly args = {
    name: Args.string({ description: 'Key name', required: true }),
  };

  static readonly flags = {
    yes: Flags.boolean({ description: 'Confirm deletion', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SshKeyDelete);
    try {
      if (!flags.yes) {
        this.error(`Refusing to delete '${args.name}' without --yes.`, { exit: 1 });
      }
      (await getVopsApp()).get(VopsSshKeysService).remove(args.name);
      if (flags.json) {
        this.log(JSON.stringify({ deleted: args.name }, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Deleted local SSH key '${args.name}'`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
