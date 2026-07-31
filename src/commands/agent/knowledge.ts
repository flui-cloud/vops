import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { AgentFailure, ExitCode, agentError } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { KnowledgeService } from '../../agent-kit/knowledge.service';

export default class AgentKnowledge extends Command {
  static readonly description = 'Search or read the bundled progressively-loaded vOps knowledge.';
  static readonly args = {
    action: Args.string({ required: true, options: ['list', 'search', 'read'] }),
    value: Args.string(),
  };
  static readonly flags = {
    limit: Flags.integer({ default: 10, min: 1, max: 25 }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentKnowledge);
    await runAgentCommand(
      this,
      `vops agent knowledge ${args.action}`,
      flags.json,
      async () => ({
        data: await withService(KnowledgeService, (knowledge) => {
          if (args.action !== 'list' && !args.value) {
            throw new AgentFailure(
              agentError('VOPS_AGENT_KNOWLEDGE_VALUE_MISSING', 'input', `${args.action} requires a value.`),
              ExitCode.INVALID_INPUT,
            );
          }
          return args.action === 'list'
            ? knowledge.list()
            : args.action === 'search'
              ? knowledge.search(args.value, flags.limit)
              : knowledge.read(args.value);
        }),
      }),
      (result) => {
        if (args.action === 'read') this.log((result as { content: string }).content);
        else this.log(JSON.stringify(result, null, 2));
      },
    );
  }
}
