import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostImport extends Command {
  static readonly description = 'Create a host from an existing provider server';

  static readonly examples = ['<%= config.bin %> <%= command.id %> ovh vops-web-abc'];

  static readonly args = {
    provider: Args.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    server: Args.string({ description: 'Server id or name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostImport);
    try {
      const { host, probe } = await (await getVopsApp())
        .get(VopsHostsService)
        .import(args.provider, args.server);
      if (flags.json) {
        this.log(JSON.stringify({ host, probe }, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Imported host '${host.name}' from ${host.provider} (${host.user}@${host.address})`));
      if (probe.reachable) {
        this.log(chalk.dim(`  reachable · ${host.os?.pretty ?? 'unknown OS'}`));
      } else {
        this.log(chalk.yellow(`  warning: ${probe.message}`));
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
