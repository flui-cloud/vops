import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { renderTable } from '../../lib/output';
import { loadCatalog } from '../../apps/catalog';

export default class AppCatalog extends Command {
  static readonly description = 'List the bundled flui catalog apps installable with `vops app install`.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json'];

  static readonly flags = {
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AppCatalog);
    const entries = loadCatalog();
    if (flags.json) {
      this.log(JSON.stringify(entries.map(({ manifest, ...meta }) => meta), null, 2));
      return;
    }
    this.log(
      renderTable(
        ['ID', 'NAME', 'TYPE', 'CATEGORY', 'VERSION'],
        entries.map((e) => [chalk.bold(e.id), e.name, e.type, chalk.dim(e.category), e.version]),
      ),
    );
    this.log(chalk.dim(`\n${entries.length} apps · install with: vops app install <id> --host <host> --yes`));
  }
}
