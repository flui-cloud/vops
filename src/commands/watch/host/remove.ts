import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsMonitorService } from '../../../monitor/vops-monitor.service';
import { assertApproved } from '../../../safety/approval-gate';

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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchHostRemove);
    await runAgentCommand(
      this,
      'vops watch host remove',
      flags.json,
      async () => {
        assertApproved({
          operation: 'Remove monitor',
          target: args.name,
          approved: flags.yes,
          consequence: 'It is the alert that fires if the host goes silent.',
        });
        return { data: await withService(VopsMonitorService, (svc) => svc.remove(args.name)) };
      },
      (res) => this.log(chalk.green(`✓ Monitor removed from '${res.host}'`)),
    );
  }
}
