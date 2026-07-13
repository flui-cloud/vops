import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostList extends Command {
  static readonly description = 'List known hosts';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HostList);
    try {
      const hosts = (await getVopsApp()).get(VopsHostsService).list();
      if (flags.json) {
        this.log(JSON.stringify(hosts, null, 2));
        return;
      }
      if (!hosts.length) {
        this.log('No hosts. Add one with: vops host add <name> --address <ip|fqdn>');
        return;
      }
      this.log(
        renderTable(
          ['NAME', 'ADDRESS', 'USER', 'OS', 'OPS KEY', 'TAGS'],
          hosts.map((h) => [
            h.name,
            `${h.address}:${h.port}`,
            h.user,
            h.os?.pretty ?? chalk.dim('unknown'),
            h.opsKeyInstalled ? chalk.green('yes') : chalk.dim('no'),
            h.tags.join(',') || chalk.dim('-'),
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
