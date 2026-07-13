import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
import { VopsAgentService } from '../../../agent/vops-agent.service';

export default class HostAgentRemove extends Command {
  static readonly description = 'Remove the in-guest metrics agent from a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { json: Flags.boolean({ description: 'Output as JSON', default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostAgentRemove);
    try {
      const res = await (await getVopsApp()).get(VopsAgentService).remove(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Agent removed from '${res.host}'`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
