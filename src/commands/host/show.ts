import { Args, Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostShow extends Command {
  static readonly description = 'Show a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1', '<%= config.bin %> <%= command.id %> web1 --json'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostShow);
    await runAgentCommand(
      this,
      'vops host show',
      flags.json,
      async () => ({
        data: await withService(VopsHostsService, (svc) => svc.show(args.name)),
        nextActions: [
          { command: `vops host status ${args.name} --json`, description: 'Live health of this host over SSH' },
          { command: `vops app preflight ${args.name} --json`, description: 'Whether it can run flui.yaml apps' },
        ],
      }),
      (host) => {
        this.log(`name:     ${host.name}`);
        this.log(`address:  ${host.user}@${host.address}:${host.port}`);
        this.log(`os:       ${host.os?.pretty ?? 'unknown'} (${host.os?.family ?? 'unknown'})`);
        this.log(`ops key:  ${host.opsKeyInstalled ? 'installed' : 'not installed'}`);
        if (host.userKeyName) this.log(`user key: ${host.userKeyName}`);
        if (host.provider) this.log(`provider: ${host.provider} (${host.providerServerId})`);
        if (host.tags.length) this.log(`tags:     ${host.tags.join(', ')}`);
        this.log(`added:    ${host.addedAt}`);
      },
    );
  }
}
