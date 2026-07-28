import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsServersService } from '../../servers/vops-servers.service';

export default class ServersShow extends Command {
  static readonly description = 'Show a server details (live)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> 12345 --provider hetzner'];

  static readonly args = {
    id: Args.string({ description: 'Server id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ServersShow);
    await runAgentCommand(
      this,
      'vops servers show',
      flags.json,
      async () => {
        const server = await withService(VopsServersService, (svc) => svc.show(flags.provider, args.id));
        if (!server) {
          throw new AgentFailure(
            agentError('VOPS_SERVER_NOT_FOUND', 'input', `Server ${args.id} not found on ${flags.provider}.`, {
              suggestedAction: `List what exists with \`vops servers list --provider ${flags.provider} --json\`.`,
            }),
            ExitCode.INVALID_INPUT,
          );
        }
        return { data: server };
      },
      (server) => this.log(JSON.stringify(server, null, 2)),
    );
  }
}
