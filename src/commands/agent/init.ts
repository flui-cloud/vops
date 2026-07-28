import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { VopsAgentApiService } from '../../agent-api/vops-agent-api.service';
import { InitResult } from '../../agent-api/agent-project';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class AgentInit extends Command {
  static readonly description =
    'Create .vops/ for this project: plans, reports and provenance. Idempotent, local only — ' +
    'nothing remote is touched and no credential is read.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --project . --json'];

  static readonly flags = {
    project: Flags.string({ default: '.', description: 'Project root' }),
    spec: Flags.string({ default: 'flui.yaml', description: 'Manifest path, relative to the project root' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AgentInit);
    try {
      const svc = (await getVopsApp()).get(VopsAgentApiService);
      await runAgentCommand(
        this,
        'vops agent init',
        flags.json,
        async () => ({
          data: svc.init(flags.project, flags.spec),
          nextActions: [
            { command: 'vops spec templates --json', description: 'Pick the framework template that matches this repository' },
          ],
        }),
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function render(cmd: Command, r: InitResult): void {
  cmd.log(chalk.green('✓ project ready ') + chalk.dim(r.root));
  for (const c of r.created) cmd.log(chalk.dim(`  + ${c}`));
  if (!r.created.length) cmd.log(chalk.dim('  (already initialised — nothing changed)'));
  cmd.log(chalk.dim(`  spec: ${r.project.spec} · vops ${r.project.vopsVersion}`));
}
