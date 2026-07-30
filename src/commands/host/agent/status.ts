import { Args, Command } from '@oclif/core';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsAgentService } from '../../../agent/vops-agent.service';

export default class HostAgentStatus extends Command {
  static readonly description = 'Run the agent once and print its in-guest metrics snapshot';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostAgentStatus);
    await runAgentCommand(
      this,
      'vops host agent status',
      flags.json,
      async () => ({ data: await withService(VopsAgentService, (svc) => svc.snapshot(args.name)) }),
      (snap) => {
        this.log(`cpu:  ${snap.cpu?.usagePercent ?? '?'}% (load1 ${snap.cpu?.load1 ?? '?'}, ${snap.cpu?.cores ?? '?'} cores)`);
        this.log(`mem:  ${snap.mem?.usedPercent ?? '?'}% used`);
        for (const d of snap.disks ?? []) this.log(`disk: ${d.mount} ${d.usedPercent}%`);
      },
    );
  }
}
