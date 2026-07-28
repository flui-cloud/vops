import { Command } from '@oclif/core';
import chalk from 'chalk';
import { renderTable } from '../../lib/output';
import { CatalogListing, listCatalog } from '../../apps/catalog-view';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class CatalogProducts extends Command {
  static readonly description = 'Ready-to-deploy applications in the bundled catalog (install with `vops app install <id>`).';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json'];

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(CatalogProducts);
    await runAgentCommand(this, 'vops catalog products', flags.json, async () => ({ data: listCatalog('product') }), (rows) =>
      renderCatalog(this, rows, 'vops app install <id> --host <host> --yes'),
    );
  }
}

export function renderCatalog(cmd: Command, rows: CatalogListing[], hint: string): void {
  cmd.log(
    renderTable(
      ['ID', 'NAME', 'CATEGORY', 'VERSION'],
      rows.map((e) => [chalk.bold(e.id), e.name, chalk.dim(e.category), e.version]),
    ),
  );
  cmd.log(chalk.dim(`\n${rows.length} entries · ${hint}`));
}
