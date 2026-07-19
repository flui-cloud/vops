import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { LocalStore } from '../../lib/store/local-store';
import { CompareRow, compareRuns } from '../../bench/bench-compare';
import { renderCompareShare } from '../../bench/bench-share';
import { BenchResultV1 } from '../../bench/bench.model';

const header = (r: BenchResultV1) => ({
  id: r.id,
  host: r.host.name,
  startedAt: r.startedAt,
  profile: r.profile,
});

export default class BenchCompare extends Command {
  static readonly description =
    'Compare two stored benchmark runs — self-relative deltas only, caveats always shown';

  static readonly examples = ['<%= config.bin %> <%= command.id %> b-abc123 b-def456'];

  static readonly args = {
    idA: Args.string({ description: 'First run id (A, the baseline)', required: true }),
    idB: Args.string({ description: 'Second run id (B)', required: true }),
  };

  static readonly flags = {
    share: Flags.boolean({ description: 'Print a paste-ready markdown artifact', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BenchCompare);
    try {
      const store = (await getVopsApp()).get(LocalStore);
      const a = await store.getBenchRun(args.idA);
      if (!a) this.error(`No benchmark run '${args.idA}'.`, { exit: 1 });
      const b = await store.getBenchRun(args.idB);
      if (!b) this.error(`No benchmark run '${args.idB}'.`, { exit: 1 });
      const cmp = compareRuns(a, b);
      if (flags.json) {
        this.log(JSON.stringify(cmp, null, 2));
        return;
      }
      if (flags.share) {
        this.log(renderCompareShare({ ...cmp, a: header(a), b: header(b) }));
        return;
      }
      this.log(
        chalk.bold(`${a.host.name} ${a.startedAt.slice(0, 10)}`) + chalk.dim(' (A)  vs  ') +
          chalk.bold(`${b.host.name} ${b.startedAt.slice(0, 10)}`) + chalk.dim(' (B)'),
      );
      for (const c of cmp.caveats) this.log(chalk.yellow(`! ${c}`));
      this.log(
        renderTable(
          ['METRIC', 'A', 'B', 'Δ'],
          cmp.rows.map((row) => [row.label, fmt(row.a), fmt(row.b), delta(row)]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}

const fmt = (v: number | null): string => {
  if (v == null) return chalk.dim('—');
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
};

const delta = (row: CompareRow): string => {
  if (row.deltaPct == null) return chalk.dim('—');
  const text = `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`;
  if (Math.abs(row.deltaPct) < 3) return chalk.dim(`≈ ${text}`);
  const good = row.deltaPct > 0 === (row.better === 'up');
  return good ? chalk.green(text) : chalk.red(text);
};
