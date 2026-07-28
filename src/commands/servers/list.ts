import { Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsServersService } from '../../servers/vops-servers.service';

export default class ServersList extends Command {
  static readonly description = 'List servers on a provider account (live)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> --provider hetzner'];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServersList);
    await runAgentCommand(
      this,
      'vops servers list',
      flags.json,
      // `managed` comes from the service, which sees the provider labels the
      // mapped DTO drops — re-deriving it here would miss a label-tagged server.
      async () => ({ data: await withService(VopsServersService, (svc) => svc.list(flags.provider)) }),
      (servers) => {
        this.log(
          renderTable(
            ['ID', 'NAME', 'TYPE', 'LOCATION', 'STATUS', 'PUBLIC IP', 'VOPS'],
            servers.map((s) => [
              s.id,
              s.name,
              s.type,
              s.location,
              s.status,
              s.publicIp ?? '-',
              s.managed ? 'yes' : '-',
            ]),
          ),
        );
      },
    );
  }
}
