import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { renderShare } from '../../bench/bench-share';
import { readings } from '../../bench/bench-bands';
import { BenchResultV1 } from '../../bench/bench.model';
import { LocalStore } from '../../lib/store/local-store';
import { metricsCell } from './host';

export default class BenchShow extends Command {
  static readonly description = 'Show a stored benchmark run (human, --json, or --share markdown)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> b-abc123',
    '<%= config.bin %> <%= command.id %> b-abc123 --share',
  ];

  static readonly args = {
    id: Args.string({ description: 'Benchmark run id', required: true }),
  };

  static readonly flags = {
    share: Flags.boolean({ description: 'Print a paste-ready markdown artifact', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BenchShow);
    try {
      const run = await (await getVopsApp()).get(LocalStore).getBenchRun(args.id);
      if (!run) {
        this.error(`No benchmark run '${args.id}'.`, { exit: 1 });
      }
      if (flags.json) {
        this.log(JSON.stringify(run, null, 2));
        return;
      }
      if (flags.share) {
        this.log(renderShare(run));
        return;
      }
      this.renderHuman(run);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }

  private renderHuman(r: BenchResultV1): void {
    const reading = readings(r);
    const band = (key: string): string => {
      const b = reading.bands[key];
      return b ? chalk.dim(` (${b})`) : '';
    };
    const m = r.meta;
    const runsNote = (r.runs ?? 1) > 1 ? chalk.dim(` · median of ${r.runs} runs`) : '';
    this.log(chalk.bold(`${r.host.name}`) + chalk.dim(`  ${r.id} · ${r.profile} v${r.profileVersion} · ${r.startedAt.slice(0, 10)}`) + runsNote);
    this.log(chalk.dim(`${m.cpuModel} · ${m.cores} cores · ${m.memGb} GB · ${m.virt} · ${m.osPretty}`));
    this.log(
      renderTable(
        ['PROBE', 'RESULT'],
        r.probes.map((p) => [
          p.id,
          p.status === 'done'
            ? metricsCell(p) + band(p.id)
            : chalk.yellow(`skipped (${p.note})`),
        ]),
      ),
    );
    this.log(chalk.dim(`steal avg ${r.steal.avg}% · max ${r.steal.max}% · mode ${r.mode}`) + band('steal'));
    for (const d of reading.diagnostics) this.log(chalk.dim(`≈ ${d}`));
    for (const w of r.warnings) this.log(chalk.yellow(`! ${w}`));
  }
}
