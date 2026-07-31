import { Args, Command, Flags } from '@oclif/core';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { CapabilityRegistry } from '../../agent-control/capability-registry';

export default class CapabilityDescribe extends Command {
  static readonly description = 'Describe one semantic agent capability.';
  static readonly args = { id: Args.string({ required: true }) };
  static readonly flags = { format: Flags.string({ options: ['json'], default: 'json' }) };
  async run(): Promise<void> {
    const { args } = await this.parse(CapabilityDescribe);
    const app = await getVopsApp();
    try {
      this.log(JSON.stringify(app.get(CapabilityRegistry).describe(args.id)));
    } finally {
      await closeVopsApp();
    }
  }
}
