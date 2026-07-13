import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
import { VopsAgentService } from '../../../agent/vops-agent.service';

export default class HostAgentStatus extends Command {
  static readonly description = 'Run the agent once and print its in-guest metrics snapshot';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { json: Flags.boolean({ description: 'Output as JSON', default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostAgentStatus);
    try {
      const snap = await (await getVopsApp()).get(VopsAgentService).snapshot(args.name);
      if (flags.json) {
        this.log(JSON.stringify(snap, null, 2));
        return;
      }
      this.log(`cpu:  ${snap.cpu?.usagePercent ?? '?'}% (load1 ${snap.cpu?.load1 ?? '?'}, ${snap.cpu?.cores ?? '?'} cores)`);
      this.log(`mem:  ${snap.mem?.usedPercent ?? '?'}% used`);
      for (const d of snap.disks ?? []) this.log(`disk: ${d.mount} ${d.usedPercent}%`);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
