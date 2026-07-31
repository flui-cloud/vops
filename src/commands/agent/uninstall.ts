import { Args, Command, Flags } from '@oclif/core';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { AgentClientAdapters, ClientInstallScope, SupportedAgentClient } from '../../agent-clients/client-adapters';

export default class AgentUninstall extends Command {
  static readonly description = 'Remove only vOps-managed coding-agent integration while preserving unrelated config.';
  static readonly args = {
    client: Args.string({ options: ['codex', 'claude-code', 'opencode', 'antigravity'] }),
  };
  static readonly flags = {
    scope: Flags.string({ options: ['project', 'user'], default: 'project' }),
    client: Flags.string({ options: ['codex', 'claude-code', 'opencode', 'antigravity'] }),
    project: Flags.string({ default: '.' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentUninstall);
    await runAgentCommand(
      this,
      'vops agent uninstall',
      flags.json,
      async () => {
        const client = flags.client ?? args.client;
        if (!client) {
          throw new AgentFailure(
            agentError(
              'VOPS_AGENT_CLIENT_MISSING',
              'input',
              'Name a client with --client or a positional argument.',
            ),
            ExitCode.INVALID_INPUT,
          );
        }
        return {
          data: new AgentClientAdapters().uninstall(
            client as SupportedAgentClient,
            flags.scope as ClientInstallScope,
            flags.project,
          ),
        };
      },
      (result) => {
        this.log(`Removed vOps-managed ${result.client} integration.`);
        result.changed.forEach((file) => this.log(`  changed ${file}`));
      },
    );
  }
}
