import { Args, Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { KnowledgeService } from '../../agent-kit/knowledge.service';

export default class KnowledgeRead extends Command {
  static readonly description = 'Read one published vOps knowledge resource.';
  static readonly args = { resource: Args.string({ required: true }) };
  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowledgeRead);
    await runAgentCommand(
      this,
      'vops knowledge read',
      flags.json,
      async () => ({ data: await withService(KnowledgeService, (knowledge) => knowledge.read(args.resource)) }),
      (result) => this.log(result.content),
    );
  }
}
