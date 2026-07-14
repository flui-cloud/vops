import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
import { VopsMonitorService } from '../../../monitor/vops-monitor.service';

export default class WatchHostRemove extends Command {
  static readonly description = 'Stop watching a host for silence — remove the monitor (script + env + crontab + relay host). Requires --yes';

  static readonly aliases = ['host:monitor:remove'];
  static readonly deprecateAliases = true;

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1 --yes'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    yes: Flags.boolean({ description: 'Confirm — removing the monitor silences the outage alert for this host', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchHostRemove);
    try {
      if (!flags.yes) {
        this.error(
          `Refusing to remove the monitor on '${args.name}' without confirmation — it is the alert that fires if the host goes silent. Re-run with --yes.`,
          { exit: 1 },
        );
      }
      const res = await (await getVopsApp()).get(VopsMonitorService).remove(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Monitor removed from '${res.host}'`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
