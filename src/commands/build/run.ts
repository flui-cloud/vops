import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { BuildRunResult, VopsBuildService } from '../../build/vops-build.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { carried, flagArg } from '../../agent-api/follow-up';

export default class BuildRun extends Command {
  static readonly description =
    'Trigger the vops build workflow on GitHub and (with --wait) return the image reference it produced. ' +
    'vops never builds locally or on the target VPS.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --wait --json',
    '<%= config.bin %> <%= command.id %> --branch main --token $GITHUB_TOKEN',
  ];

  static readonly flags = {
    project: Flags.string({ default: '.', description: 'Project root' }),
    repo: Flags.string({ description: 'owner/name (default: the origin remote)' }),
    branch: Flags.string({ description: 'Branch to build (default: the current one)' }),
    token: Flags.string({ description: 'GitHub PAT (default: the encrypted store, then GITHUB_TOKEN)', env: 'VOPS_GITHUB_TOKEN' }),
    wait: Flags.boolean({ default: false, description: 'Poll until the run finishes' }),
    timeout: Flags.integer({ default: 20, description: 'Minutes to wait with --wait' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BuildRun);
    try {
      const svc = (await getVopsApp()).get(VopsBuildService);
      await runAgentCommand(
        this,
        'vops build run',
        flags.json,
        async () => {
          const data = await svc.run({
            projectDir: flags.project,
            repo: flags.repo,
            branch: flags.branch,
            token: flags.token,
            wait: flags.wait,
            timeoutMs: flags.timeout * 60_000,
          });
          return { data, warnings: privateWarning(data), nextActions: nextActions(data, flags.project) };
        },
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function privateWarning(r: BuildRunResult) {
  if (!r.repoPrivate) return [];
  return [
    {
      code: 'VOPS_IMAGE_MAY_BE_PRIVATE',
      message:
        'The repository is private, so the published package likely is too. The host then needs pull credentials ' +
        '(--registry-user / --registry-token at deploy) — scope that token to reading packages only.',
    },
  ];
}

function nextActions(r: BuildRunResult, project: string) {
  if (r.imageRef) {
    const ctx = carried(flagArg('project', project, '.'));
    return [{ command: `vops deploy plan --spec flui.yaml --host <host> --image ${r.imageRef}${ctx} --json`, description: 'Plan the deployment with this image' }];
  }
  return [{ command: 'vops build status --json', description: 'Check the run again' }];
}

function render(cmd: Command, r: BuildRunResult): void {
  const conclusion = r.conclusion ? ` · ${r.conclusion}` : '';
  cmd.log(chalk.bold(`run ${r.runId}`) + chalk.dim(`  ${r.status}${conclusion}`));
  cmd.log(chalk.dim(`  ${r.runUrl}`));
  if (r.imageRef) cmd.log(chalk.green('  image: ') + chalk.cyan(r.imageRef));
  else cmd.log(chalk.dim('  no image yet — re-check with `vops build status`'));
}
