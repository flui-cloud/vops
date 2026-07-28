import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { InstallSkillResult, SKILL_TARGETS, SkillTarget, installSkill, skillInstructions } from '../../agent-api/skill-install';

export default class AgentSkill extends Command {
  static readonly description =
    'Install the canonical vops-deploy skill into a coding agent. For an agent that is not listed, ' +
    'pass --output-dir and put the bundle where that agent reads skills from.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> install claude-code',
    '<%= config.bin %> <%= command.id %> install codex --project .',
    '<%= config.bin %> <%= command.id %> install --output-dir ./agent-skills --json',
    '<%= config.bin %> <%= command.id %> targets',
  ];

  static readonly args = {
    action: Args.string({ description: "'install' or 'targets'", options: ['install', 'targets'], default: 'targets' }),
    target: Args.string({ description: `Agent id (${SKILL_TARGETS.map((t) => t.id).join(' | ')})` }),
  };

  static readonly flags = {
    'output-dir': Flags.string({ description: 'Write the bundle here instead of a known agent directory' }),
    project: Flags.string({ description: 'Install into this project rather than the home directory (Claude Code, Codex, Antigravity)' }),
    force: Flags.boolean({ default: false, description: 'Replace an existing bundle' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentSkill);
    if (args.action === 'targets') {
      await runAgentCommand(this, 'vops agent skill targets', flags.json, async () => ({ data: skillInstructions() }), (rows) => {
        for (const t of rows) {
          this.log(`${chalk.bold(t.id)}  ${chalk.dim(t.label)}`);
          this.log(chalk.dim(`   ${t.command}`) + chalk.dim(`  → ${t.homePath}`));
          if (t.projectCommand) this.log(chalk.dim(`   ${t.projectCommand}`) + chalk.dim(`  → ${t.projectPath}`));
          if (t.note) this.log(chalk.yellow(`   ! ${t.note}`));
        }
        this.log(chalk.dim('\nany other agent: vops agent skill install --output-dir <dir>'));
      });
      return;
    }

    await runAgentCommand(
      this,
      'vops agent skill install',
      flags.json,
      async () => {
        if (!args.target && !flags['output-dir']) {
          throw new AgentFailure(
            agentError('VOPS_SKILL_TARGET_MISSING', 'input', 'Name an agent, or pass --output-dir.', {
              suggestedAction: `vops agent skill install <${SKILL_TARGETS.map((t) => t.id).join('|')}>, or --output-dir <dir>.`,
            }),
            ExitCode.INVALID_INPUT,
          );
        }
        try {
          return {
            data: installSkill({
              target: args.target as SkillTarget | undefined,
              outputDir: flags['output-dir'],
              project: flags.project,
              force: flags.force,
            }),
          };
        } catch (err) {
          throw new AgentFailure(
            agentError('VOPS_SKILL_INSTALL_FAILED', 'input', err instanceof Error ? err.message : String(err)),
            ExitCode.INVALID_INPUT,
          );
        }
      },
      (data: InstallSkillResult) => {
        this.log(chalk.green(`✓ installed vops-deploy for ${data.target}`));
        this.log(chalk.dim(`  ${data.dir}`));
        for (const f of data.files) this.log(chalk.dim(`  + ${f}`));
        if (data.overwritten) this.log(chalk.yellow('  ! replaced an existing bundle'));
        if (data.note) this.log(chalk.dim(`  ${data.note}`));
      },
    );
  }
}
