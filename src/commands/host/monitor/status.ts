import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
import { VopsMonitorService } from '../../../monitor/vops-monitor.service';

export default class HostMonitorStatus extends Command {
  static readonly description = 'Relay-side monitor status: last heartbeat and open alerts';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostMonitorStatus);
    try {
      const res = await (await getVopsApp()).get(VopsMonitorService).status(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      const state = { ok: chalk.green('ok'), alert: chalk.red('alert'), silent: chalk.red('silent') }[res.state] ?? chalk.dim(res.state);
      this.log(`${chalk.bold(res.name)}  ${state}  ${chalk.dim('last seen ' + (res.lastSeen ?? 'never'))}`);
      for (const a of res.openAlerts) {
        this.log(`  ${chalk.yellow(a.severity)}  ${a.summary}`);
      }
      if (!res.openAlerts.length) this.log(chalk.dim('  no open alerts'));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
