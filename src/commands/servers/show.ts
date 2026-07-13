import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsServersService } from '../../servers/vops-servers.service';

export default class ServersShow extends Command {
  static readonly description = 'Show a server details (live)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 12345 --provider hetzner',
  ];

  static readonly args = {
    id: Args.string({ description: 'Server id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ServersShow);
    try {
      const server = await (await getVopsApp())
        .get(VopsServersService)
        .show(flags.provider, args.id);

      if (!server) {
        this.error(`Server ${args.id} not found on ${flags.provider}.`, {
          exit: 1,
        });
      }
      if (flags.json) {
        this.log(JSON.stringify(server, null, 2));
        return;
      }
      this.log(JSON.stringify(server, null, 2));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
