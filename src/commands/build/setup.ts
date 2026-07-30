import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { SetupResult, VopsBuildService } from '../../build/vops-build.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { carried, flagArg } from '../../agent-api/follow-up';

export default class BuildSetup extends Command {
  static readonly description =
    'Write the GitHub Actions workflow that builds this application and pushes it to GHCR. ' +
    'vops writes the file and stops — committing and pushing it is your call, so the change is reviewable first.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --spec flui.yaml --repo owner/name --branch main --json',
  ];

  static readonly flags = {
    spec: Flags.string({ default: 'flui.yaml', description: 'Application manifest (its build block drives the workflow)' }),
    project: Flags.string({ default: '.', description: 'Project root' }),
    repo: Flags.string({ description: 'owner/name (default: the origin remote)' }),
    branch: Flags.string({ description: 'Branch a push to which triggers a build (default: the current one)' }),
    force: Flags.boolean({ default: false, description: 'Replace a workflow file vops did not write' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BuildSetup);
    try {
      const svc = (await getVopsApp()).get(VopsBuildService);
      await runAgentCommand(
        this,
        'vops build setup',
        flags.json,
        async () => {
          const data = svc.setup({
            projectDir: flags.project,
            specFile: flags.spec,
            repo: flags.repo,
            branch: flags.branch,
            force: flags.force,
          });
          return {
            data,
            warnings: data.skippedReason ? [{ code: 'VOPS_BUILD_WORKFLOW_KEPT', message: data.skippedReason }] : [],
            nextActions: data.written
              ? [
                  { command: `git add ${data.workflowFile} && git commit -m "ci: build image for vops" && git push`, description: 'Commit the workflow — the user does this, not you' },
                  { command: `vops build run --wait${carried(flagArg('project', flags.project, '.'))} --json`, description: 'Trigger the build and wait for the image reference' },
                ]
              : [],
          };
        },
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function render(cmd: Command, r: SetupResult): void {
  if (!r.written) {
    cmd.log(chalk.yellow(`! kept ${r.workflowFile}`));
    cmd.log(chalk.dim(`  ${r.skippedReason}`));
    return;
  }
  cmd.log(chalk.green('✓ wrote ') + chalk.bold(r.workflowFile));
  cmd.log(chalk.dim(`  repo: ${r.repo.owner}/${r.repo.repo} · branch: ${r.repo.branch}`));
  cmd.log(chalk.dim(`  image: ${r.image}:<short-sha>`));
  cmd.log(chalk.dim('\n  review it, commit it, push it — then: vops build run --wait'));
}
