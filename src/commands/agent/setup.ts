import { Args, Command, Flags } from '@oclif/core';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { AgentClientAdapters, ClientInstallScope, SupportedAgentClient } from '../../agent-clients/client-adapters';

export default class AgentSetup extends Command {
  static readonly description = 'Install the canonical vOps skill, MCP config and managed bootstrap for a coding agent.';
  static readonly args = {
    client: Args.string({ options: ['codex', 'claude-code', 'opencode', 'antigravity', 'all'] }),
  };
  static readonly flags = {
    scope: Flags.string({ options: ['project', 'user'], default: 'project' }),
    client: Flags.string({ options: ['codex', 'claude-code', 'opencode', 'antigravity', 'all'] }),
    project: Flags.string({ default: '.', description: 'Project root for project-scoped setup' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentSetup);
    await runAgentCommand(
      this,
      'vops agent setup',
      flags.json,
      async () => {
        const adapters = new AgentClientAdapters();
        const selected = flags.client ?? args.client;
        if (!selected) {
          throw new AgentFailure(
            agentError(
              'VOPS_AGENT_CLIENT_MISSING',
              'input',
              'Name a client with --client or a positional argument.',
            ),
            ExitCode.INVALID_INPUT,
          );
        }
        const clients = selected === 'all' ? adapters.clients() : [selected as SupportedAgentClient];
        return {
          data: clients.map((client) =>
            adapters.install(client, flags.scope as ClientInstallScope, flags.project),
          ),
        };
      },
      (results) => {
        for (const result of results) {
          this.log(`Configured ${result.client} (${result.scope}).`);
          result.changed.forEach((file) => this.log(`  changed ${file}`));
          result.backups.forEach((file) => this.log(`  backup  ${file}`));
          if (!result.changed.length) this.log('  already up to date');
        }
      },
    );
  }
}
