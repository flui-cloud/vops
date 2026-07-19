import { BenchResultV1 } from './bench.model';

/**
 * Self-relative run comparison: two runs of the same host, or two hosts side by
 * side. Deltas are raw percentages with a declared "better" direction — no
 * composite score, and the caveats (profile mismatch, in-vivo floors) are part
 * of the result so every renderer must show them.
 */
export interface CompareRow {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  deltaPct: number | null;
  better: 'up' | 'down';
}

export interface CompareResult {
  rows: CompareRow[];
  caveats: string[];
}

function metricOf(r: BenchResultV1, id: string, key: string): number | null {
  const p = r.probes.find((x) => x.id === id && x.status === 'done');
  const v = p?.metrics[key];
  return typeof v === 'number' ? v : null;
}

function aesGbps(r: BenchResultV1): number | null {
  const p = r.probes.find((x) => x.id === 'cpu.crypto' && x.status === 'done');
  if (!p) return null;
  const key = Object.keys(p.metrics).find((k) => k.toLowerCase().includes('aes'));
  return key == null ? null : p.metrics[key] / 1e9;
}

interface RowDef {
  key: string;
  label: string;
  better: 'up' | 'down';
  get: (r: BenchResultV1) => number | null;
}

const ROWS: RowDef[] = [
  { key: 'cpu.multi', label: 'CPU multi (MIPS)', better: 'up', get: (r) => metricOf(r, 'cpu.multi', 'mips') },
  { key: 'cpu.single', label: 'CPU single (MIPS)', better: 'up', get: (r) => metricOf(r, 'cpu.single', 'mips') },
  { key: 'mem.bw', label: 'Memory (MiB/s)', better: 'up', get: (r) => metricOf(r, 'mem.bw', 'mibps') },
  { key: 'aes', label: 'AES (GB/s)', better: 'up', get: aesGbps },
  { key: 'rr4k.iops', label: '4k read (IOPS)', better: 'up', get: (r) => metricOf(r, 'disk.rr4k', 'iops') },
  { key: 'rr4k.p99', label: '4k read p99 (ms)', better: 'down', get: (r) => metricOf(r, 'disk.rr4k', 'p99ms') },
  { key: 'rw4k.iops', label: '4k write (IOPS)', better: 'up', get: (r) => metricOf(r, 'disk.rw4k', 'iops') },
  { key: 'rw4k.p99', label: '4k write p99 (ms)', better: 'down', get: (r) => metricOf(r, 'disk.rw4k', 'p99ms') },
  { key: 'sr1m', label: 'Seq read (MB/s)', better: 'up', get: (r) => metricOf(r, 'disk.sr1m', 'mbps') },
  { key: 'sw1m', label: 'Seq write (MB/s)', better: 'up', get: (r) => metricOf(r, 'disk.sw1m', 'mbps') },
];

function invivoCaveat(tag: string, r: BenchResultV1): string[] {
  return r.mode === 'in-vivo'
    ? [`${r.host.name} (${tag}) measured in-vivo (baseline load1 ${r.baseline.load1}) — its numbers are floors`]
    : [];
}

const runsOf = (r: BenchResultV1): number => r.runs ?? 1;

function caveats(a: BenchResultV1, b: BenchResultV1): string[] {
  return [
    ...(Number(a.profileVersion) !== Number(b.profileVersion)
      ? [`different profile versions (v${a.profileVersion} vs v${b.profileVersion}) — NOT comparable`]
      : []),
    ...(a.profile !== b.profile ? ['different profiles — durations differ, treat deltas with care'] : []),
    ...(runsOf(a) !== runsOf(b)
      ? [`different run counts (${runsOf(a)} vs ${runsOf(b)}) — medians vs single samples`]
      : []),
    ...invivoCaveat('A', a),
    ...invivoCaveat('B', b),
  ];
}

export function compareRuns(a: BenchResultV1, b: BenchResultV1): CompareResult {
  const rows = ROWS.map((def) => {
    const va = def.get(a);
    const vb = def.get(b);
    const deltaPct = va != null && vb != null && va > 0 ? ((vb - va) / va) * 100 : null;
    return { key: def.key, label: def.label, a: va, b: vb, deltaPct, better: def.better };
  });
  return { rows, caveats: caveats(a, b) };
}
