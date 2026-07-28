import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { WORKFLOWS, WorkflowDescriptor, findWorkflow } from '../../agent-api/agent-workflow';

type WorkflowView = WorkflowDescriptor | Array<{ id: string; title: string; description: string }>;
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';

export default class AgentWorkflow extends Command {
  static readonly description =
    'The stages of a vops deployment and the command that drives each one. ' +
    'A map, not an engine: vops does not read the repository or pick a template — those stages are yours.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> custom-app --json',
    '<%= config.bin %> <%= command.id %>',
  ];

  static readonly args = { id: Args.string({ description: 'Workflow id (default: list them all)' }) };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentWorkflow);
    await runAgentCommand<WorkflowView>(
      this,
      'vops agent workflow',
      flags.json,
      async () => {
        if (!args.id) return { data: WORKFLOWS.map(({ id, title, description }) => ({ id, title, description })) };
        const data = findWorkflow(args.id);
        if (!data) {
          throw new AgentFailure(
            agentError('VOPS_WORKFLOW_NOT_FOUND', 'input', `Unknown workflow '${args.id}'.`, {
              suggestedAction: `Available: ${WORKFLOWS.map((w) => w.id).join(', ')}.`,
            }),
            ExitCode.INVALID_INPUT,
          );
        }
        return { data };
      },
      (data) => render(this, data),
    );
  }
}

function render(cmd: Command, data: WorkflowDescriptor | Array<{ id: string; title: string }>): void {
  if (Array.isArray(data)) {
    for (const w of data) cmd.log(`${chalk.bold(w.id)}  ${chalk.dim(w.title)}`);
    return;
  }
  cmd.log(chalk.bold(data.title));
  cmd.log(chalk.dim(data.description));
  cmd.log('');
  for (const s of data.stages) {
    const owner = s.owner === 'agent' ? chalk.magenta('you') : chalk.cyan(s.owner);
    const approval = s.approval === 'C' ? chalk.red('needs approval') : chalk.dim(`class ${s.approval}`);
    cmd.log(`${chalk.bold(s.id)}  ${s.title}  ${owner} ${approval}`);
    cmd.log(chalk.dim(`   ${s.description}`));
    for (const c of s.commands) cmd.log(chalk.dim('   $ ') + c);
    cmd.log('');
  }
}
