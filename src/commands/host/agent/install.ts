import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
import { VopsAgentService } from '../../../agent/vops-agent.service';

export default class HostAgentInstall extends Command {
  static readonly description = 'Install the optional in-guest metrics agent (scp + sha256-verified, no daemon)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { json: Flags.boolean({ description: 'Output as JSON', default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostAgentInstall);
    try {
      const res = await (await getVopsApp()).get(VopsAgentService).install(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Agent installed on '${res.host}' (v${res.agentVersion}, verified)`));
      this.log(chalk.dim('  host status now includes agent.cpu/mem/disk findings'));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
