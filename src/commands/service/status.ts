import { Command } from '@oclif/core';
import * as path from 'node:path';
import chalk from 'chalk';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { probeInstance } from '../../local-api/instance-probe';
import { resolveContext, serviceStatus } from '../../service/index';
import { statusLines } from '../../service/service-report';

export default class ServiceStatus extends Command {
  static readonly description = 'Show whether the background service is installed, running and answering';

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServiceStatus);
    await runAgentCommand(
      this,
      'vops service status',
      flags.json,
      async () => {
        const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });
        // Installed and running is what the OS reports; answering is what the user
        // actually cares about, and only a request can tell us that.
        const live = await probeInstance(ctx.port);
        return { data: { port: ctx.port, profile: ctx.profile, service: serviceStatus(ctx), answering: live !== null, version: live?.version ?? null } };
      },
      (state) => {
        this.log('');
        for (const line of statusLines(state.service)) this.log(line);
        this.log(
          state.answering
            ? chalk.green(`  Answering on http://127.0.0.1:${state.port}`)
            : chalk.dim(`  Nothing is answering on http://127.0.0.1:${state.port}`),
        );
        this.log('');
      },
    );
  }
}
