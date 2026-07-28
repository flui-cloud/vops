import { Command } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { VopsAgentApiService } from '../../agent-api/vops-agent-api.service';
import { CapabilityReport } from '../../agent-api/agent-capabilities';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class AgentCapabilities extends Command {
  static readonly description =
    'What this build of vops can do. Ask before assuming — a capability missing here is not available, ' +
    'whatever a skill or a doc says. Reads no credential and never prompts for the vault passphrase.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> --json'];

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(AgentCapabilities);
    try {
      const svc = (await getVopsApp()).get(VopsAgentApiService);
      await runAgentCommand(
        this,
        'vops agent capabilities',
        flags.json,
        async () => ({
          data: svc.capabilities(),
          nextActions: [
            { command: 'vops agent workflow custom-app --json', description: 'The stages of a custom application deployment' },
          ],
        }),
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function render(cmd: Command, r: CapabilityReport): void {
  cmd.log(chalk.bold(`vops ${r.vopsVersion}`) + chalk.dim(`  flui-spec ${r.specVersion}`));
  cmd.log(
    chalk.dim(
      `catalog: ${r.catalog.products} products · ${r.catalog.buildingBlocks} building blocks · ${r.catalog.frameworkTemplates} framework templates`,
    ),
  );
  cmd.log('');
  for (const [name, available] of Object.entries(r.capabilities)) {
    const badge = available ? chalk.green('yes') : chalk.dim('no ');
    const detail = r.details[name as keyof typeof r.details];
    const detailText = detail ? chalk.dim(` — ${detail}`) : '';
    cmd.log(`  ${badge}  ${chalk.bold(name)}${detailText}`);
  }
  cmd.log('');
  cmd.log(chalk.dim(`credentials: vault ${r.credentials.vault}`) + (r.credentials.configured ? chalk.dim(` · configured: ${r.credentials.configured.join(', ') || 'none'}`) : chalk.dim(' · locked, run `vops keyring unlock` to list')));
}
