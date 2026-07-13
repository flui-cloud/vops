import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
import { VopsMonitorService } from '../../../monitor/vops-monitor.service';

export default class HostMonitorTest extends Command {
  static readonly description = 'Force one immediate monitor run over SSH (sends a heartbeat now)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostMonitorTest);
    try {
      const res = await (await getVopsApp()).get(VopsMonitorService).test(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.ran) {
        this.log(chalk.green(`✓ Monitor ran on '${res.host}' (heartbeat sent to relay)`));
      } else {
        this.error(`Monitor run failed on '${res.host}': ${res.stderr ?? 'unknown'}`, { exit: 1 });
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
