import { Command } from '@oclif/core';
import chalk from 'chalk';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { FRAMEWORK_TEMPLATES } from '../../spec/template-registry';

/**
 * A signpost: framework templates live under `vops spec`, but `vops catalog` is
 * where people look for "what can I deploy". It still answers `--json` with a
 * real envelope — a command that takes the flag and prints prose tells an agent
 * the contract holds when it does not.
 */
export default class CatalogTemplates extends Command {
  static readonly description = 'Framework templates for custom applications — see `vops spec templates`.';

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(CatalogTemplates);
    await runAgentCommand(
      this,
      'vops catalog templates',
      flags.json,
      async () => ({
        data: {
          movedTo: 'vops spec templates',
          count: FRAMEWORK_TEMPLATES.length,
          ids: FRAMEWORK_TEMPLATES.map((t) => t.id),
        },
        nextActions: [
          { command: 'vops spec templates --json', description: 'The framework templates, with their ports and limitations' },
          { command: 'vops spec templates describe <id> --json', description: 'One template in full' },
          { command: 'vops spec generate --template <id> --name <app> --output-file flui.yaml --json', description: 'Generate the base manifest' },
        ],
      }),
      ({ count }) => {
        this.log(`Framework templates live under \`vops spec\` (${count} available):`);
        this.log(chalk.dim('  vops spec templates --json'));
        this.log(chalk.dim('  vops spec templates describe <id> --json'));
        this.log(chalk.dim('  vops spec generate --template <id> --name <app> --output-file flui.yaml'));
      },
    );
  }
}
