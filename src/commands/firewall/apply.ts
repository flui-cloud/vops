import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';

export default class FirewallApply extends Command {
  static readonly description =
    'Apply (or --remove) a firewall to/from servers';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner --servers 111,222',
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner --servers 111 --remove',
  ];

  static readonly args = {
    id: Args.string({ description: 'Firewall id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    servers: Flags.string({ description: 'Comma-separated server ids', required: true }),
    remove: Flags.boolean({ description: 'Remove instead of apply', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FirewallApply);
    const serverIds = flags.servers.split(',').map((s) => s.trim()).filter(Boolean);
    await runAgentCommand(
      this,
      'vops firewall apply',
      flags.json,
      async () => {
        await withService(VopsFirewallService, (svc) =>
          flags.remove ? svc.remove(flags.provider, args.id, serverIds) : svc.apply(flags.provider, args.id, serverIds),
        );
        return { data: { id: args.id, serverIds, removed: flags.remove } };
      },
      (res) => this.log(chalk.green(`✓ ${res.removed ? 'Removed from' : 'Applied to'} ${res.serverIds.length} server(s).`)),
    );
  }
}
