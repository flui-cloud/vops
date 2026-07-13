import { Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsServersService } from '../../servers/vops-servers.service';

export default class ServersList extends Command {
  static readonly description = 'List servers on a provider account (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServersList);
    try {
      const servers = await (await getVopsApp())
        .get(VopsServersService)
        .list(flags.provider);

      if (flags.json) {
        this.log(JSON.stringify(servers, null, 2));
        return;
      }

      this.log(
        renderTable(
          ['ID', 'NAME', 'TYPE', 'LOCATION', 'STATUS', 'PUBLIC IP'],
          servers.map((s) => [
            s.id,
            s.name,
            s.type,
            s.location,
            s.status,
            s.publicIp ?? '-',
          ]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
