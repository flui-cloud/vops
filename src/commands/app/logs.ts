import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsAppsService } from '../../apps/vops-apps.service';

export default class AppLogs extends Command {
  static readonly description = 'Tail the journald logs of a deployed app’s primary component.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> it-tools',
    '<%= config.bin %> <%= command.id %> it-tools -n 500',
    '<%= config.bin %> <%= command.id %> it-tools --json',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    lines: Flags.integer({ char: 'n', default: 200, description: 'Number of log lines' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppLogs);
    await runAgentCommand(
      this,
      'vops app logs',
      flags.json,
      async () => {
        const text = await withService(VopsAppsService, (svc) => svc.logs(args.name, flags.lines));
        // Split for the envelope: one 200-line string is a blob an agent has to
        // re-parse, and journald already delimits by line.
        return { data: { app: args.name, lines: text.split('\n') } };
      },
      ({ lines }) => this.log(lines.join('\n')),
    );
  }
}
