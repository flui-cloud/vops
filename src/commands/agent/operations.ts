import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { OperationManager } from '../../agent-control/operation-manager';

export default class AgentOperations extends Command {
  static readonly description = 'List, inspect or request cancellation of agent operations.';
  static readonly args = {
    action: Args.string({ required: true, options: ['list', 'show', 'cancel'] }),
    id: Args.string(),
  };
  static readonly flags = {
    session: Flags.string(),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentOperations);
    await runAgentCommand(
      this,
      `vops agent operations ${args.action}`,
      flags.json,
      async () => ({
        data: await withService(OperationManager, async (operations) => {
          if (args.action !== 'list' && !args.id) {
            throw new AgentFailure(
              agentError('VOPS_AGENT_OPERATION_ID_MISSING', 'input', `${args.action} requires an operation id.`),
              ExitCode.INVALID_INPUT,
            );
          }
          return args.action === 'list'
            ? operations.list(flags.session)
            : args.action === 'show'
              ? operations.get(args.id)
              : operations.requestCancel(args.id);
        }),
      }),
      (result) => this.log(JSON.stringify(result, null, 2)),
    );
  }
}
