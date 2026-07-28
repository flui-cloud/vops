import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { BuildRunResult, VopsBuildService } from '../../build/vops-build.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class BuildStatus extends Command {
  static readonly description = 'The most recent vops build run for this repository. Triggers nothing.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> --json'];

  static readonly flags = {
    project: Flags.string({ default: '.', description: 'Project root' }),
    repo: Flags.string({ description: 'owner/name (default: the origin remote)' }),
    branch: Flags.string({ description: 'Branch (default: the current one)' }),
    token: Flags.string({ description: 'GitHub PAT (default: the encrypted store, then GITHUB_TOKEN)', env: 'VOPS_GITHUB_TOKEN' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BuildStatus);
    try {
      const svc = (await getVopsApp()).get(VopsBuildService);
      await runAgentCommand<BuildRunResult | null>(
        this,
        'vops build status',
        flags.json,
        async () => ({
          data: await svc.status({ projectDir: flags.project, repo: flags.repo, branch: flags.branch, token: flags.token }),
        }),
        (data) => {
          if (!data) {
            this.log(chalk.dim('No run yet. Commit and push .github/workflows/vops-build.yml, then `vops build run`.'));
            return;
          }
          const conclusion = data.conclusion ? ` · ${data.conclusion}` : '';
          this.log(chalk.bold(`run ${data.runId}`) + chalk.dim(`  ${data.status}${conclusion}`));
          this.log(chalk.dim(`  ${data.runUrl}`));
          if (data.imageRef) this.log(chalk.green('  image: ') + chalk.cyan(data.imageRef));
        },
      );
    } finally {
      await closeVopsApp();
    }
  }
}
