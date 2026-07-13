import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
import { renderTable } from '../../../lib/output';
import { VopsHostKeysService } from '../../../host-ops/vops-host-keys.service';

export default class HostKeyStatus extends Command {
  static readonly description = 'Show which vops-known keys are authorized on a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostKeyStatus);
    try {
      const res: any = await (await getVopsApp()).get(VopsHostKeysService).keyStatus(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      this.log(chalk.dim(`${res.path} · ops tag ${res.opsTagPresent ? chalk.green('present') : chalk.dim('absent')}`));
      this.log(
        renderTable(
          ['KEY', 'ROLE', 'AUTHORIZED'],
          res.keys.map((k: any) => [
            k.name,
            k.role,
            k.authorized ? chalk.green('yes') : chalk.dim('no'),
          ]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
