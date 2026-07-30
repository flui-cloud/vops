import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { LocalStore } from '../../lib/store/local-store';

export default class BenchList extends Command {
  static readonly description = 'List stored benchmark runs';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Restrict to one host' }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BenchList);
    await runAgentCommand(
      this,
      'vops bench list',
      flags.json,
      async () => ({ data: await withService(LocalStore, (store) => store.listBenchRuns(args.name)) }),
      (runs) => {
        if (!runs.length) {
          this.log('No benchmark runs. Run one with: vops bench host <name> --yes');
          return;
        }
        this.log(
          renderTable(
            ['ID', 'HOST', 'PROFILE', 'DATE', 'CPU MIPS', 'MEM MiB/s', 'RR4K IOPS'],
            runs.map((r) => [
              r.id,
              r.host,
              r.profile,
              r.startedAt.slice(0, 10),
              num(r.headline.mips),
              num(r.headline.memMiBs),
              num(r.headline.rr4kIops),
            ]),
          ),
        );
      },
    );
  }
}

const num = (n?: number): string => (n == null ? chalk.dim('-') : String(Math.round(n)));
