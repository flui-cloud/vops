import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsAgentService } from '../../../agent/vops-agent.service';

export default class HostAgentInstall extends Command {
  static readonly description = 'Install the optional in-guest metrics agent (scp + sha256-verified, no daemon)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostAgentInstall);
    await runAgentCommand(
      this,
      'vops host agent install',
      flags.json,
      async () => ({ data: await withService(VopsAgentService, (svc) => svc.install(args.name)) }),
      (res) => {
        this.log(chalk.green(`✓ Agent installed on '${res.host}' (v${res.agentVersion}, verified)`));
        this.log(chalk.dim('  host status now includes agent.cpu/mem/disk findings'));
      },
    );
  }
}
