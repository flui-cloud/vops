import { Command } from '@oclif/core';
import { listCatalog } from '../../apps/catalog-view';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderCatalog } from './products';

export default class CatalogBlocks extends Command {
  static readonly description =
    'Reusable infrastructure services (databases, caches, object storage) an application can be built on. ' +
    'Each installs on its own host slot like any other app.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json'];

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(CatalogBlocks);
    await runAgentCommand(this, 'vops catalog blocks', flags.json, async () => ({ data: listCatalog('block') }), (rows) =>
      renderCatalog(this, rows, 'vops app install <id> --host <host> --yes'),
    );
  }
}
