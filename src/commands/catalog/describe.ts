import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { describeCatalog } from '../../apps/catalog-view';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';

export default class CatalogDescribe extends Command {
  static readonly description = 'Show one catalog entry: what it is, and what it will ask for at install.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> postgresql --json'];

  static readonly args = { id: Args.string({ description: 'Catalog id', required: true }) };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CatalogDescribe);
    await runAgentCommand(
      this,
      'vops catalog describe',
      flags.json,
      async () => {
        const data = describeCatalog(args.id);
        if (!data) {
          throw new AgentFailure(
            agentError('VOPS_CATALOG_NOT_FOUND', 'input', `Unknown catalog id '${args.id}'.`, {
              suggestedAction: 'List them with `vops catalog products --json` or `vops catalog blocks --json`.',
            }),
            ExitCode.INVALID_INPUT,
          );
        }
        return { data };
      },
      (e) => {
        this.log(chalk.bold(e.id) + chalk.dim(`  ${e.name} · ${e.kind} · ${e.category} · v${e.version}`));
        if (e.description) this.log(e.description);
        if (!e.installable) this.log(chalk.yellow(`not installable yet: ${e.unavailableReason}`));
        if (e.alternativeTo.length) this.log(chalk.dim(`alternative to: ${e.alternativeTo.join(', ')}`));
        for (const i of e.inputs) {
          this.log(`  input ${chalk.cyan(i.name)} ${chalk.dim(i.label)}${i.required ? chalk.yellow(' (required)') : ''}${i.sensitive ? chalk.dim(' [secret]') : ''}`);
        }
      },
    );
  }
}
