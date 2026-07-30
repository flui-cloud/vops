import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { agentError } from '../../../agent-api/agent-envelope';
import { VopsMonitorService } from '../../../monitor/vops-monitor.service';

export default class WatchHostTest extends Command {
  static readonly description = 'Force one immediate monitor run over SSH (sends a heartbeat now)';

  static readonly aliases = ['host:monitor:test'];
  static readonly deprecateAliases = true;

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchHostTest);
    await runAgentCommand(
      this,
      'vops watch host test',
      flags.json,
      async () => {
        const data = await withService(VopsMonitorService, (svc) => svc.test(args.name));
        return {
          data,
          errors: data.ran
            ? []
            : [
                agentError('VOPS_OPERATION_FAILED', 'operational', `Monitor run failed on '${data.host}': ${data.stderr ?? 'unknown'}`, {
                  suggestedAction: 'Read data.stderr; the monitor script or its relay credentials on the host need attention.',
                }),
              ],
        };
      },
      (res) => {
        if (res.ran) this.log(chalk.green(`✓ Monitor ran on '${res.host}' (heartbeat sent to relay)`));
      },
    );
  }
}
