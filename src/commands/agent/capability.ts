import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { CapabilityRegistry } from '../../agent-control/capability-registry';

export default class AgentCapability extends Command {
  static readonly description = 'List or describe the authoritative agent capability registry.';
  static readonly args = {
    action: Args.string({ required: true, options: ['list', 'describe'] }),
    id: Args.string(),
  };
  static readonly flags = {
    all: Flags.boolean({ default: false, description: 'Include unavailable capabilities' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentCapability);
    await runAgentCommand(
      this,
      `vops agent capability ${args.action}`,
      flags.json,
      async () => ({
        data: await withService(CapabilityRegistry, (registry) => {
          if (args.action === 'describe' && !args.id) {
            throw new AgentFailure(
              agentError('VOPS_AGENT_CAPABILITY_ID_MISSING', 'input', 'describe requires a capability id.'),
              ExitCode.INVALID_INPUT,
            );
          }
          return args.action === 'list'
            ? { schemaVersion: registry.schemaVersion, capabilities: registry.list({ includeUnavailable: flags.all }) }
            : registry.describe(args.id);
        }),
      }),
      (result) => this.log(JSON.stringify(result, null, 2)),
    );
  }
}
