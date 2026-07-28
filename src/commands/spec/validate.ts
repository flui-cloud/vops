import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { ValidateResult, VopsSpecService } from '../../spec/vops-spec.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class SpecValidate extends Command {
  static readonly description =
    'Validate a flui.yaml against the flui-spec schema. Exits 0 when valid, 3 when it is not — ' +
    'errors carry a stable code, a path and the action that fixes them.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> flui.yaml',
    '<%= config.bin %> <%= command.id %> flui.yaml --json',
  ];

  static readonly args = {
    file: Args.string({ description: 'Path to the manifest', default: 'flui.yaml' }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SpecValidate);
    try {
      const svc = (await getVopsApp()).get(VopsSpecService);
      await runAgentCommand(
        this,
        'vops spec validate',
        flags.json,
        async () => {
          const data = svc.validate(args.file);
          return {
            data,
            errors: data.errors,
            warnings: data.warnings,
            nextActions: data.valid
              ? [{ command: `vops deploy plan --spec ${args.file} --host <host> --json`, description: 'Render the deployment plan' }]
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

function render(cmd: Command, r: ValidateResult): void {
  if (r.valid) {
    cmd.log(chalk.green('✓ valid ') + chalk.bold(r.file) + chalk.dim(`  kind: ${r.kind}`));
  } else {
    cmd.log(chalk.red('✗ invalid ') + chalk.bold(r.file));
    for (const e of r.errors) {
      cmd.log(`  ${chalk.red(e.code)} ${chalk.dim(e.path ?? '')} ${e.message}`);
      if (e.suggestedAction) cmd.log(chalk.dim(`      → ${e.suggestedAction}`));
    }
  }
  for (const w of r.warnings) cmd.log(chalk.yellow(`  ! ${w.path ?? ''} ${w.message}`));
}
