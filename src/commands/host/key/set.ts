import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsHostsService } from '../../../hosts/vops-hosts.service';

export default class HostKeySet extends Command {
  static readonly description =
    'Assign the local SSH key vops uses to reach a host (the key YOU log in with, not the ' +
    'automation key `host key install-ops` manages). Use --clear to unassign it.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1 laptop',
    '<%= config.bin %> <%= command.id %> web1 --clear',
  ];

  static readonly args = {
    host: Args.string({ description: 'Host name', required: true }),
    key: Args.string({ description: 'Local SSH key name (see: vops ssh-key list)' }),
  };

  static readonly flags = {
    clear: Flags.boolean({ default: false, description: 'Unassign the current key instead of setting one' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostKeySet);
    await runAgentCommand(
      this,
      'vops host key set',
      flags.json,
      async () => {
        if (!flags.clear && !args.key) {
          this.error('Name the key to assign, or pass --clear to unassign.', { exit: 2 });
        }
        const host = await withService(VopsHostsService, (svc) =>
          svc.setUserKey(args.host, flags.clear ? undefined : args.key),
        );
        return {
          data: { host: host.name, userKeyName: host.userKeyName ?? null },
          nextActions: [
            { command: `vops host status ${host.name} --json`, description: 'Check the host is now reachable with that key' },
          ],
        };
      },
      (d) => {
        this.log(
          d.userKeyName
            ? chalk.green(`✓ ${d.host} now uses key `) + chalk.cyan(d.userKeyName)
            : chalk.green(`✓ ${d.host} has no key assigned`),
        );
      },
    );
  }
}
