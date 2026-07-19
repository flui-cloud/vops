import { BenchProbeResult, BenchResultV1 } from './bench.model';
import { BANDS_VERSION, bandFor, bandForMetric, diagnostics } from './bench-bands';
import { CompareRow } from './bench-compare';

/**
 * Pure markdown renderer for `bench show --share`. It receives a `BenchResultV1`,
 * which cannot carry the host address / user / port by construction, so the
 * paste-ready artifact is sanitized structurally (a test greps for the address).
 */
const UNIT: Record<string, { label: string; fmt: (v: number) => string }> = {
  mips: { label: 'MIPS', fmt: (v) => String(Math.round(v)) },
  iops: { label: 'IOPS', fmt: (v) => String(Math.round(v)) },
  p99ms: { label: 'clat p99', fmt: (v) => `${v.toFixed(2)} ms` },
  mbps: { label: 'throughput', fmt: (v) => `${v.toFixed(0)} MB/s` },
  mibps: { label: 'bandwidth', fmt: (v) => `${v.toFixed(0)} MiB/s` },
};

function metricLabel(key: string): string {
  return UNIT[key]?.label ?? key;
}

function metricValue(key: string, v: number): string {
  const u = UNIT[key];
  return u ? u.fmt(v) : `${(v / 1e9).toFixed(2)} GB/s`;
}

const round2 = (n: number): string => String(Math.round(n * 100) / 100);

export function formatMetricsInline(metrics: Record<string, number>): string {
  return Object.entries(metrics)
    .map(([k, v]) => `${metricLabel(k)} ${metricValue(k, v)}`)
    .join(' · ');
}

function metaTable(r: BenchResultV1): string[] {
  const m = r.meta;
  const mode =
    r.mode === 'in-vivo'
      ? `in-vivo (baseline load1 ${round2(r.baseline.load1)}, steal ${round2(r.baseline.steal)}%)`
      : 'clean-room';
  const rows: Array<[string, string]> = [
    ['CPU', m.cpuModel],
    ['Cores', String(m.cores)],
    ['RAM', `${m.memGb} GB`],
    ['Virt', m.virt],
    ['Kernel', m.kernel],
    ['OS', m.osPretty],
    ['Mode', mode],
    ['Profile', `${r.profile} (v${r.profileVersion})`],
    ['Date', r.startedAt.slice(0, 10)],
  ];
  return ['| field | value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)];
}

function valueCell(p: BenchProbeResult, key: string, v: number): string {
  const s = p.spread?.[key];
  const suffix = s ? ` (±${s.spreadPct}%, n=${s.n})` : '';
  return metricValue(key, v) + suffix;
}

function metricsTable(probes: BenchProbeResult[]): string[] {
  const rows = probes
    .filter((p) => p.status === 'done')
    .flatMap((p) =>
      Object.entries(p.metrics).map(
        ([k, v]) =>
          `| ${p.id} | ${metricLabel(k)} | ${valueCell(p, k, v)} | ${bandForMetric(p.id, k, v) ?? ''} |`,
      ),
    );
  return ['| probe | metric | value | reading |', '| --- | --- | --- | --- |', ...rows];
}

function stealLine(r: BenchResultV1): string {
  const band = bandFor('stealPct', r.steal.avg);
  const suffix = band ? ` — ${band}` : '';
  return `CPU steal: avg ${round2(r.steal.avg)}% · max ${round2(r.steal.max)}%${suffix}`;
}

function skippedLine(probes: BenchProbeResult[]): string[] {
  const skipped = probes.filter((p) => p.status === 'skipped');
  if (!skipped.length) return [];
  const items = skipped.map((p) => `${p.id} (${p.note ?? 'n/a'})`).join(', ');
  return ['', `Skipped: ${items}`];
}

function warningLines(warnings: string[]): string[] {
  return warnings.length ? ['', ...warnings.map((w) => `> ${w}`)] : [];
}

export function renderShare(r: BenchResultV1): string {
  const runsNote = (r.runs ?? 1) > 1 ? ` · median of ${r.runs} runs` : '';
  return [
    `## vops bench — ${r.host.name}`,
    '',
    ...metaTable(r),
    '',
    ...metricsTable(r.probes),
    '',
    stealLine(r),
    ...skippedLine(r.probes),
    ...warningLines(r.warnings),
    ...warningLines(diagnostics(r)),
    '',
    `Reproduce: vops bench host ${r.host.name} --profile ${r.profile}   (vops bench profile v${r.profileVersion} · bands v${BANDS_VERSION}${runsNote})`,
  ].join('\n');
}

export interface CompareShareParty {
  id: string;
  host: string;
  startedAt: string;
  profile: string;
}

export interface CompareShareInput {
  rows: CompareRow[];
  caveats: string[];
  a: CompareShareParty;
  b: CompareShareParty;
}

const cmpVal = (v: number | null): string => {
  if (v == null) return '—';
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
};

const cmpDelta = (row: CompareRow): string => {
  if (row.deltaPct == null) return '—';
  const text = `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`;
  return Math.abs(row.deltaPct) < 3 ? `≈ ${text}` : text;
};

/** Markdown for a shared comparison — b is the subject ("this run"), a the baseline. */
export function renderCompareShare(cmp: CompareShareInput): string {
  const date = (s: string): string => s.slice(0, 10);
  return [
    `## vops bench compare — ${cmp.b.host} ${date(cmp.b.startedAt)} vs ${cmp.a.host} ${date(cmp.a.startedAt)}`,
    ...(cmp.caveats.length ? ['', ...cmp.caveats.map((c) => `> ${c}`)] : []),
    '',
    '| metric | baseline | this run | Δ |',
    '| --- | --- | --- | --- |',
    ...cmp.rows.map((row) => `| ${row.label} | ${cmpVal(row.a)} | ${cmpVal(row.b)} | ${cmpDelta(row)} |`),
    '',
    `Reproduce: vops bench compare ${cmp.a.id} ${cmp.b.id}`,
  ].join('\n');
}
