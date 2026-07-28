import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { renderTable } from '../../lib/output';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { VopsSpecService, TemplateDetail, TemplateSummary } from '../../spec/vops-spec.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';

export default class SpecTemplates extends Command {
  static readonly description =
    'List the framework templates `vops spec generate` can produce a base flui.yaml from, ' +
    'or describe one. vops lists the options; choosing the right one is the caller’s job.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> describe nestjs-11 --json',
  ];

  static readonly args = {
    action: Args.string({ description: "'describe' to show one template", options: ['describe'] }),
    id: Args.string({ description: 'Template id (with describe)' }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SpecTemplates);
    try {
      const svc = (await getVopsApp()).get(VopsSpecService);
      if (args.action === 'describe') {
        if (!args.id) this.error('Pass a template id: vops spec templates describe <id>', { exit: 2 });
        await runAgentCommand(this, 'vops spec templates describe', flags.json, async () => ({ data: svc.describe(args.id) }), renderDetail(this));
        return;
      }
      await runAgentCommand(this, 'vops spec templates', flags.json, async () => ({ data: svc.templates() }), renderList(this));
    } finally {
      await closeVopsApp();
    }
  }
}

function renderList(cmd: Command) {
  return (rows: TemplateSummary[]): void => {
    cmd.log(
      renderTable(
        ['ID', 'NAME', 'RUNTIME', 'PORT', 'HEALTH'],
        rows.map((t) => [chalk.bold(t.id), t.name, chalk.dim(t.runtime), String(t.port), chalk.dim(t.healthPath)]),
      ),
    );
    cmd.log(chalk.dim(`\n${rows.length} templates · describe one: vops spec templates describe <id>`));
  };
}

function renderDetail(cmd: Command) {
  return (t: TemplateDetail): void => {
    cmd.log(chalk.bold(`${t.id}`) + chalk.dim(`  ${t.name} · ${t.runtime} · v${t.version}`));
    cmd.log(t.description);
    cmd.log(chalk.dim(`port ${t.port} · health ${t.healthPath} · dockerfile ${t.dockerfile}`));
    if (t.baseImages.length) cmd.log(chalk.dim(`reference images: ${t.baseImages.join(', ')}`));
    cmd.log(chalk.dim(`source: ${t.sourceRepo}`));
    if (t.limitations.length) {
      cmd.log(chalk.bold('\nknown limitations'));
      for (const l of t.limitations) cmd.log(chalk.yellow(`  ! ${l}`));
    }
    cmd.log(chalk.bold('\nexample'));
    cmd.log(chalk.dim(t.example.trimEnd()));
  };
}
