import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { LocalStore } from '../../lib/store/local-store';

export default class BenchList extends Command {
  static readonly description = 'List stored benchmark runs';

  static readonly examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> web1'];

  static readonly args = {
    name: Args.string({ description: 'Restrict to one host' }),
  };

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BenchList);
    try {
      const runs = await (await getVopsApp()).get(LocalStore).listBenchRuns(args.name);
      if (flags.json) {
        this.log(JSON.stringify(runs, null, 2));
        return;
      }
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
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}

const num = (n?: number): string => (n == null ? chalk.dim('-') : String(Math.round(n)));
