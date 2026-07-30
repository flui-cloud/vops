import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { approvalPending } from '../../safety/approval-gate';
import type { EnvelopeOptions } from '../../agent-api/agent-envelope';
import { renderTable } from '../../lib/output';
import { formatMetricsInline } from '../../bench/bench-share';
import { readings } from '../../bench/bench-bands';
import { BenchProbeResult, BenchProfile, BenchResultV1 } from '../../bench/bench.model';
import { BenchPreflight, BenchProgress, VopsBenchService } from '../../bench/vops-bench.service';

export default class BenchHost extends Command {
  static readonly description =
    'Benchmark an inventory host over SSH (a disruptive read: saturates CPU/disk for minutes). ' +
    'Without --yes it only runs the preflight and reports what would happen.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --yes',
    '<%= config.bin %> <%= command.id %> web1 --profile full --install --yes',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    profile: Flags.string({ options: ['quick', 'full'], default: 'quick', description: 'Battery profile' }),
    install: Flags.boolean({ description: 'Best-effort install of missing tools via the package manager', default: false }),
    runs: Flags.integer({ default: 1, min: 1, max: 5, description: 'Repeat the whole battery N times; report median and spread' }),
    yes: Flags.boolean({ description: 'Run the battery (otherwise only preflight is shown)', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BenchHost);
    const profile = flags.profile as BenchProfile;
    await runAgentCommand<BenchPreflight | BenchResultV1>(
      this,
      'vops bench host',
      flags.json,
      async () =>
        withService(
          VopsBenchService,
          async (svc): Promise<{ data: BenchPreflight | BenchResultV1 } & EnvelopeOptions> => {
            if (!flags.yes) {
              return {
                data: await svc.preflight(args.name, profile),
                ...approvalPending({
                  operation: 'Benchmark host',
                  target: args.name,
                  consequence: 'The battery saturates CPU and disk for minutes — the host will be slow while it runs.',
                }),
                // Carry the flags this invocation used: a follow-up that silently drops
                // --profile or --runs runs a different benchmark than the one approved.
                nextActions: [
                  {
                    command: [
                      `vops bench host ${args.name}`,
                      ...(profile === 'quick' ? [] : [`--profile ${profile}`]),
                      ...(flags.runs === 1 ? [] : [`--runs ${flags.runs}`]),
                      ...(flags.install ? ['--install'] : []),
                      '--yes --json',
                    ].join(' '),
                    description: 'Run the battery once the user has approved',
                  },
                ],
              };
            }
            return {
              data: await svc.run(args.name, {
                profile,
                install: flags.install,
                runs: flags.runs,
                onProgress: flags.json ? undefined : (p) => this.onProgress(p),
              }),
            };
          },
        ),
      (data) => {
        if (isPreflight(data)) this.renderPreflight(data, flags.install);
        else this.renderResult(data);
      },
    );
  }

  private renderPreflight(pre: BenchPreflight, install: boolean): void {
    const m = pre.meta;
    this.log(chalk.bold(pre.host) + chalk.dim(`  bench preflight · ${pre.profile}`));
    this.log(chalk.dim(`${m.cpuModel} · ${m.cores} cores · ${m.memGb} GB · ${m.virt} · ${m.osPretty}`));
    this.log(`baseline: load1 ${pre.baseline.load1} · steal ${pre.baseline.steal}%`);
    this.log(
      `free space: ${Math.round(pre.freeKb / 1024)} MiB (need ${Math.round(pre.needKb / 1024)} MiB) ` +
        (pre.spaceOk ? chalk.green('ok') : chalk.yellow('low → disk probes skipped')),
    );
    const willRun = pre.probes.filter((p) => p.willRun).map((p) => p.id);
    const est = chalk.dim(`~${pre.estSeconds}s`);
    this.log(`probes: ${willRun.length ? willRun.join(', ') : chalk.dim('none')}  ${est}`);
    for (const p of pre.probes.filter((x) => !x.willRun)) {
      this.log(chalk.yellow(`  skip ${p.id}`) + chalk.dim(` — ${p.reason}`));
    }
    if (pre.missing.length) {
      this.log(
        chalk.dim(
          install
            ? `--install will attempt: ${pre.missing.join(', ')}`
            : `missing tools: ${pre.missing.join(', ')} (add --install to attempt install)`,
        ),
      );
    }
  }

  private onProgress(p: BenchProgress): void {
    const rounds = p.rounds ?? 1;
    const roundTag = rounds > 1 ? chalk.dim(` (round ${p.round}/${rounds})`) : '';
    const tag = chalk.dim(`[${p.index}/${p.total}]`);
    if (p.status === 'start') {
      this.log(`${tag} ${p.probe} ${chalk.dim('running…')}${roundTag}`);
      return;
    }
    if (p.status === 'skipped') {
      this.log(`${tag} ${p.probe} ${chalk.yellow('skipped')} ${chalk.dim(p.note ?? '')}`);
      return;
    }
    this.log(`${tag} ${p.probe} ${chalk.green('done')} ${chalk.dim(formatMetricsInline(p.metrics ?? {}))}${roundTag}`);
  }

  private renderResult(r: BenchResultV1): void {
    const reading = readings(r);
    const band = (key: string): string => {
      const b = reading.bands[key];
      return b ? chalk.dim(` (${b})`) : '';
    };
    const runsNote = (r.runs ?? 1) > 1 ? chalk.dim(` · median of ${r.runs} runs`) : '';
    this.log('');
    this.log(chalk.bold(r.host.name) + chalk.dim(`  ${r.profile} · v${r.profileVersion} · ${Math.round(r.durationMs / 1000)}s`) + runsNote);
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
    this.log(chalk.dim(`steal avg ${r.steal.avg}% · max ${r.steal.max}%`) + band('steal'));
    for (const d of reading.diagnostics) this.log(chalk.dim(`≈ ${d}`));
    for (const w of r.warnings) this.log(chalk.yellow(`! ${w}`));
    this.log(chalk.green(`saved as ${r.id}`) + chalk.dim(`  (vops bench show ${r.id} --share)`));
  }
}

function isPreflight(d: BenchPreflight | BenchResultV1): d is BenchPreflight {
  return 'estSeconds' in d;
}

/** Inline metrics with a dim per-metric spread suffix when it is non-trivial (≥5%). */
export function metricsCell(p: BenchProbeResult): string {
  return Object.entries(p.metrics)
    .map(([k, v]) => {
      const s = p.spread?.[k];
      const spread = s && s.spreadPct >= 5 ? chalk.dim(` ±${s.spreadPct}% · n=${s.n}`) : '';
      return formatMetricsInline({ [k]: v }) + spread;
    })
    .join(' · ');
}
