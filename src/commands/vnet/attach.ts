import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetAttach extends Command {
  static readonly description = 'Attach (or --detach) a server to/from a private network';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --server 555',
    '<%= config.bin %> <%= command.id %> net-123 --provider hetzner --server 555 --detach',
  ];

  static readonly args = {
    id: Args.string({ description: 'Network id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    server: Flags.string({ description: 'Server id', required: true }),
    detach: Flags.boolean({ description: 'Detach instead of attach', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VnetAttach);
    try {
      const svc = (await getVopsApp()).get(VopsVnetService);
      if (flags.detach) await svc.detach(flags.provider, args.id, flags.server);
      else await svc.attach(flags.provider, args.id, flags.server);

      if (flags.json) {
        this.log(JSON.stringify({ id: args.id, server: flags.server, detached: flags.detach }, null, 2));
        return;
      }
      const verb = flags.detach ? 'Detached from' : 'Attached to';
      this.log(chalk.green(`✓ ${verb} network ${args.id}.`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
