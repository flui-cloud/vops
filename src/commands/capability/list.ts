import { Command, Flags } from '@oclif/core';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { CapabilityRegistry } from '../../agent-control/capability-registry';

export default class CapabilityList extends Command {
  static readonly description = 'List semantic capabilities available to governed agents.';
  static readonly flags = {
    all: Flags.boolean({ default: false }),
    format: Flags.string({ options: ['json'], default: 'json' }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(CapabilityList);
    const app = await getVopsApp();
    try {
      const registry = app.get(CapabilityRegistry);
      this.log(JSON.stringify({
        schemaVersion: registry.schemaVersion,
        capabilities: registry.list({ includeUnavailable: flags.all }),
      }));
    } finally {
      await closeVopsApp();
    }
  }
}
