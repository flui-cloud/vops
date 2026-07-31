import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { KnowledgeService } from '../../agent-kit/knowledge.service';

export default class KnowledgeSearch extends Command {
  static readonly description = 'Search bundled vOps agent knowledge.';
  static readonly args = { query: Args.string({ required: true }) };
  static readonly flags = {
    limit: Flags.integer({ default: 10, min: 1, max: 25 }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowledgeSearch);
    await runAgentCommand(
      this,
      'vops knowledge search',
      flags.json,
      async () => ({
        data: await withService(KnowledgeService, (knowledge) => knowledge.search(args.query, flags.limit)),
      }),
      (result) => this.log(JSON.stringify(result, null, 2)),
    );
  }
}
