import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { VopsAgentApiService } from '../../agent-api/vops-agent-api.service';
import { VerifyReport } from '../../agent-api/deploy-verify';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class DeployVerify extends Command {
  static readonly description =
    'Check a deployment from this machine: units, containers, DNS resolution and a real HTTPS request. ' +
    'A deploy exiting 0 is not evidence that the app is reachable — this is.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> --app my-api --json'];

  static readonly flags = {
    app: Flags.string({ required: true, description: 'Install name' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DeployVerify);
    try {
      const svc = (await getVopsApp()).get(VopsAgentApiService);
      await runAgentCommand(
        this,
        'vops deploy verify',
        flags.json,
        async () => {
          const data = await svc.verify(flags.app);
          return {
            data,
            warnings: data.checks
              .filter((c) => c.status !== 'pass')
              .map((c) => ({ code: c.status === 'fail' ? 'VOPS_VERIFY_FAILED' : 'VOPS_VERIFY_SKIPPED', message: `${c.name}: ${c.detail}` })),
          };
        },
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function render(cmd: Command, r: VerifyReport): void {
  const badge = r.status === 'healthy' ? chalk.green('healthy') : chalk.yellow(r.status);
  cmd.log(chalk.bold(r.app) + chalk.dim(`  on ${r.host} · `) + badge);
  if (r.url) cmd.log(chalk.dim('  url: ') + chalk.cyan(r.url));
  for (const c of r.checks) {
    const mark = { pass: chalk.green('✓'), fail: chalk.red('✗'), skipped: chalk.dim('–') }[c.status];
    cmd.log(`  ${mark} ${chalk.bold(c.name)} ${chalk.dim(c.detail)}`);
  }
}
