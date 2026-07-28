import { Command, Flags } from '@oclif/core';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { VopsSpecService } from '../../spec/vops-spec.service';

export default class SpecSchema extends Command {
  static readonly description =
    'Print the JSON Schema for a flui.yaml kind, so a manifest can be checked before it is written.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --kind Application',
    '<%= config.bin %> <%= command.id %> --kind CatalogApp > catalog-app.schema.json',
  ];

  static readonly flags = {
    kind: Flags.string({ default: 'Application', options: ['Application', 'CatalogApp'], description: 'Manifest kind' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SpecSchema);
    try {
      const svc = (await getVopsApp()).get(VopsSpecService);
      this.log(JSON.stringify(svc.schema(flags.kind), null, 2));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 2 });
    } finally {
      await closeVopsApp();
    }
  }
}
