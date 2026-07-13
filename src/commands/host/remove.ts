import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostRemove extends Command {
  static readonly description = 'Forget a host (local inventory only; never touches the server)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostRemove);
    try {
      (await getVopsApp()).get(VopsHostsService).remove(args.name);
      if (flags.json) {
        this.log(JSON.stringify({ removed: args.name }, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Forgot host '${args.name}' (the server was not touched)`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
