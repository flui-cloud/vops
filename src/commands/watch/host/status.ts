import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsMonitorService } from '../../../monitor/vops-monitor.service';

export default class WatchHostStatus extends Command {
  static readonly description = 'Relay-side monitor status: last heartbeat and open alerts (not the live health — see `host status`)';

  static readonly aliases = ['host:monitor:status'];
  static readonly deprecateAliases = true;

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchHostStatus);
    await runAgentCommand(
      this,
      'vops watch host status',
      flags.json,
      async () => ({ data: await withService(VopsMonitorService, (svc) => svc.status(args.name)) }),
      (res) => {
        const state = { ok: chalk.green('ok'), alert: chalk.red('alert'), silent: chalk.red('silent') }[res.state] ?? chalk.dim(res.state);
        this.log(`${chalk.bold(res.name)}  ${state}  ${chalk.dim('last seen ' + (res.lastSeen ?? 'never'))}`);
        for (const a of res.openAlerts) {
          this.log(`  ${chalk.yellow(a.severity)}  ${a.summary}`);
        }
        if (!res.openAlerts.length) this.log(chalk.dim('  no open alerts'));
      },
    );
  }
}
