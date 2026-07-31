import { Command, Flags } from '@oclif/core';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { AgentClientAdapters } from '../../agent-clients/client-adapters';

export default class AgentClients extends Command {
  static readonly description = 'Detect supported coding agents and validate project-scoped vOps integration.';
  static readonly flags = {
    project: Flags.string({ default: '.' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AgentClients);
    await runAgentCommand(
      this,
      'vops agent clients',
      flags.json,
      async () => ({ data: new AgentClientAdapters().detect(flags.project) }),
      (rows) => {
        for (const row of rows) {
          this.log(`${row.installed ? 'ready' : row.detected ? 'found' : 'absent'}  ${row.client}`);
          this.log(`  skill=${row.skill} mcp=${row.mcp} bootstrap=${row.bootstrap}`);
          row.issues.forEach((issue) => this.log(`  issue: ${issue}`));
        }
      },
    );
  }
}
