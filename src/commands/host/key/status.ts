import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { renderTable } from '../../../lib/output';
import { VopsHostKeysService } from '../../../host-ops/vops-host-keys.service';

export default class HostKeyStatus extends Command {
  static readonly description = 'Show which vops-known keys are authorized on a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostKeyStatus);
    await runAgentCommand(
      this,
      'vops host key status',
      flags.json,
      async () => ({
        data: await withService(VopsHostKeysService, (svc) => svc.keyStatus(args.name)),
      }),
      (res) => {
        this.log(chalk.dim(`${res.path} · ops tag ${res.opsTagPresent ? chalk.green('present') : chalk.dim('absent')}`));
        this.log(
          renderTable(
            ['KEY', 'ROLE', 'AUTHORIZED'],
            res.keys.map((k) => [k.name, k.role, k.authorized ? chalk.green('yes') : chalk.dim('no')]),
          ),
        );
      },
    );
  }
}
