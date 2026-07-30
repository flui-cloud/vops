import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BenchCompare);
    let pair: { a: BenchResultV1; b: BenchResultV1 } | undefined;
    await runAgentCommand(
      this,
      'vops bench compare',
      flags.json,
      async () => {
        const [a, b] = await withService(LocalStore, async (store) => [
          await store.getBenchRun(args.idA),
          await store.getBenchRun(args.idB),
        ]);
        if (!a) throw new Error(`No benchmark run '${args.idA}'.`);
        if (!b) throw new Error(`No benchmark run '${args.idB}'.`);
        pair = { a, b };
        return { data: compareRuns(a, b) };
      },
      (cmp) => {
        if (!pair) return;
        const { a, b } = pair;
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
      },
    );
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
