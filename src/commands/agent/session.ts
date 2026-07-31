import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { AgentSessionManager } from '../../agent-control/agent-session-manager';
import { AgentClient, AgentEnvironment } from '../../agent-control/agent-model';

export default class AgentSessionCommand extends Command {
  static readonly description = 'Create and control short-lived advisory coding-agent sessions.';
  static readonly args = {
    action: Args.string({
      required: true,
      options: ['create', 'list', 'show', 'pause', 'resume', 'revoke', 'stop-all'],
    }),
    id: Args.string(),
  };
  static readonly flags = {
    client: Flags.string({
      options: ['codex', 'claude-code', 'opencode', 'antigravity', 'other'],
      default: 'other',
    }),
    objective: Flags.string(),
    repository: Flags.string({ default: '.' }),
    target: Flags.string({ multiple: true }),
    environment: Flags.string({
      options: ['development', 'staging', 'production'],
      multiple: true,
    }),
    expires: Flags.integer({ default: 60, min: 1, max: 720 }),
    'max-operations': Flags.integer({ default: 50, min: 1, max: 1000 }),
    'max-spend-eur': Flags.integer({ default: 0, min: 0 }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentSessionCommand);
    await runAgentCommand(
      this,
      `vops agent session ${args.action}`,
      flags.json,
      async () => ({
        data: await withService(AgentSessionManager, async (sessions) => {
          switch (args.action) {
            case 'create':
              if (!flags.objective) {
                throw new AgentFailure(
                  agentError('VOPS_AGENT_SESSION_OBJECTIVE_MISSING', 'input', 'session create requires --objective.'),
                  ExitCode.INVALID_INPUT,
                );
              }
              return sessions.create({
                client: flags.client as AgentClient,
                objective: flags.objective,
                repository: flags.repository,
                targets: flags.target,
                environments: flags.environment as AgentEnvironment[] | undefined,
                expiresInMinutes: flags.expires,
                maxOperations: flags['max-operations'],
                maxProviderSpendEur: flags['max-spend-eur'],
              });
            case 'list':
              return sessions.list();
            case 'stop-all':
              return sessions.stopAll();
            default:
              if (!args.id) {
                throw new AgentFailure(
                  agentError('VOPS_AGENT_SESSION_ID_MISSING', 'input', `${args.action} requires a session id.`),
                  ExitCode.INVALID_INPUT,
                );
              }
              return args.action === 'show'
                ? sessions.show(args.id)
                : args.action === 'pause'
                  ? sessions.pause(args.id)
                  : args.action === 'resume'
                    ? sessions.resume(args.id)
                    : sessions.revoke(args.id);
          }
        }),
      }),
      (result) => this.log(JSON.stringify(result, null, 2)),
    );
  }
}
