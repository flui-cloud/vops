import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { ApprovalManager } from '../../agent-control/approval-manager';

export default class AgentApprovals extends Command {
  static readonly description = 'List, approve or deny local agent approval requests.';
  static readonly args = {
    action: Args.string({ required: true, options: ['list', 'approve', 'deny'] }),
    id: Args.string(),
  };
  static readonly flags = {
    status: Flags.string({ options: ['pending', 'approved', 'denied', 'expired'] }),
    reason: Flags.string(),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentApprovals);
    await runAgentCommand(
      this,
      `vops agent approvals ${args.action}`,
      flags.json,
      async () => ({
        data: await withService(ApprovalManager, async (approvals) => {
          if (args.action !== 'list' && !args.id) {
            throw new AgentFailure(
              agentError('VOPS_AGENT_APPROVAL_ID_MISSING', 'input', `${args.action} requires an approval id.`),
              ExitCode.INVALID_INPUT,
            );
          }
          return args.action === 'list'
            ? approvals.list(flags.status)
            : args.action === 'approve'
              ? approvals.approve(args.id, flags.reason)
              : approvals.deny(args.id, flags.reason);
        }),
      }),
      (result) => this.log(JSON.stringify(result, null, 2)),
    );
  }
}
