import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsFirewallService } from '../../firewall/vops-firewall.service';

export default class FirewallShow extends Command {
  static readonly description = 'Show a firewall with its rules and targets';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> fw-123 --provider hetzner',
  ];

  static readonly args = {
    id: Args.string({ description: 'Firewall id', required: true }),
  };

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FirewallShow);
    await runAgentCommand(
      this,
      'vops firewall show',
      flags.json,
      async () => {
        const fw = await withService(VopsFirewallService, (svc) => svc.show(flags.provider, args.id));
        if (!fw) throw new Error(`Firewall '${args.id}' not found.`);
        return { data: fw };
      },
      (fw) => this.log(JSON.stringify(fw, null, 2)),
    );
  }
}
