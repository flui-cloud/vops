import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostShow extends Command {
  static readonly description = 'Show a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostShow);
    try {
      const host = (await getVopsApp()).get(VopsHostsService).show(args.name);
      if (flags.json) {
        this.log(JSON.stringify(host, null, 2));
        return;
      }
      this.log(`name:     ${host.name}`);
      this.log(`address:  ${host.user}@${host.address}:${host.port}`);
      this.log(`os:       ${host.os?.pretty ?? 'unknown'} (${host.os?.family ?? 'unknown'})`);
      this.log(`ops key:  ${host.opsKeyInstalled ? 'installed' : 'not installed'}`);
      if (host.userKeyName) this.log(`user key: ${host.userKeyName}`);
      if (host.provider) this.log(`provider: ${host.provider} (${host.providerServerId})`);
      if (host.tags.length) this.log(`tags:     ${host.tags.join(', ')}`);
      this.log(`added:    ${host.addedAt}`);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
