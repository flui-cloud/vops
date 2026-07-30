import { Command } from '@oclif/core';
import chalk from 'chalk';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { installableCell, renderTable } from '../../lib/output';
import { loadCatalog } from '../../apps/catalog';
import { unavailableNote } from '../../apps/catalog-installable';

export default class AppCatalog extends Command {
  static readonly description = 'List the bundled flui catalog apps installable with `vops app install`.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json'];

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(AppCatalog);
    await runAgentCommand(
      this,
      'vops app catalog',
      flags.json,
      async () => ({ data: loadCatalog().map(({ manifest, ...meta }) => meta) }),
      (entries) => {
        this.log(
          renderTable(
            ['ID', 'NAME', 'TYPE', 'CATEGORY', 'VERSION', 'INSTALLABLE'],
            entries.map((e) => [
              chalk.bold(e.id),
              e.name,
              e.type,
              chalk.dim(e.category),
              e.version,
              installableCell(e.installable),
            ]),
          ),
        );
        this.log(chalk.dim(`\n${entries.length} apps · install with: vops app install <id> --host <host> --yes`));
        const note = unavailableNote(entries);
        if (note) this.log(chalk.yellow(`\n${note}`));
      },
    );
  }
}
