import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable, yesNo, createLabel } from '../../lib/output';
import { VopsProvidersService } from '../../providers/vops-providers.service';

export default class ProvidersList extends Command {
  static readonly description =
    'List supported providers with billing model and the provisioning write-gate';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProvidersList);
    try {
      const app = await getVopsApp();
      const rows = app.get(VopsProvidersService).list();

      if (flags.json) {
        this.log(JSON.stringify(rows, null, 2));
        return;
      }

      this.log(
        renderTable(
          ['PROVIDER', 'BILLING', 'CREATE', 'FIREWALL', 'DNS', 'PRIV-NET'],
          rows.map((r) => [
            r.displayName,
            r.billingModel,
            createLabel(r.writeEnabled, r.guided),
            yesNo(r.features.firewall),
            yesNo(r.features.dns),
            yesNo(r.features.privateNetwork),
          ]),
        ),
      );
      const blocked = rows.filter((r) => !r.writeEnabled);
      for (const r of blocked) {
        this.log(chalk.dim(`\n${r.displayName}: ${r.writeDisabledReason}`));
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), {
        exit: 1,
      });
    } finally {
      await closeVopsApp();
    }
  }
}
