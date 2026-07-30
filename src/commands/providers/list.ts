import { Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable, yesNo, createLabel } from '../../lib/output';
import { VopsProvidersService } from '../../providers/vops-providers.service';

export default class ProvidersList extends Command {
  static readonly description =
    'List supported providers with billing model and the provisioning write-gate';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(ProvidersList);
    await runAgentCommand(
      this,
      'vops providers list',
      flags.json,
      async () => ({ data: await withService(VopsProvidersService, (svc) => svc.list()) }),
      (rows) => {
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
        for (const r of rows.filter((x) => !x.writeEnabled)) {
          this.log(chalk.dim(`\n${r.displayName}: ${r.writeDisabledReason}`));
        }
      },
    );
  }
}
