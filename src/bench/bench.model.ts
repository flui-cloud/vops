/**
 * `vops bench` result contracts (schema v1). Frozen per `profileVersion`: probes
 * and parameters are versioned so numbers stay comparable across posts. The share
 * artifact is built from `BenchResultV1`, which — by construction — carries only
 * the inventory alias, never the host address / user / port / key path.
 */
export type BenchProfile = 'quick' | 'full';
export type BenchMode = 'in-vivo' | 'clean-room';

export const PROFILE_VERSION = 1 as const;

export interface BenchSample {
  probe: string;
  t: number;
  steal: number;
  load1: number;
}

export interface BenchMetricSpread {
  min: number;
  max: number;
  spreadPct: number;
  n: number;
}

export interface BenchProbeResult {
  id: string;
  status: 'done' | 'skipped';
  /** e.g. "tool missing: fio" — only for skipped. */
  note?: string;
  /** Unit depends on probe: MIPS, bytes/s, MiB/s, IOPS, MB/s. Median across rounds when runs > 1. */
  metrics: Record<string, number>;
  spread?: Record<string, BenchMetricSpread>;
}

export interface BenchMeta {
  cpuModel: string;
  cores: number;
  memGb: number;
  virt: string;
  kernel: string;
  osPretty: string;
  toolVersions: Record<string, string>;
}

export interface BenchResultV1 {
  schema: 'vops.bench.v1';
  id: string;
  profile: BenchProfile;
  profileVersion: 1;
  mode: BenchMode;
  host: { name: string };
  startedAt: string;
  durationMs: number;
  meta: BenchMeta;
  baseline: { load1: number; steal: number };
  /** Battery repetitions (interleaved rounds). Old stored results lack it → read as 1. */
  runs: number;
  probes: BenchProbeResult[];
  samples: BenchSample[];
  steal: { avg: number; max: number };
  warnings: string[];
}

export interface BenchRunSummary {
  id: string;
  host: string;
  profile: BenchProfile;
  startedAt: string;
  headline: Record<string, number>;
}

/** Headline numbers for the `bench list` table — never re-parses raw tool output. */
export function benchSummary(r: BenchResultV1): BenchRunSummary {
  const pick = (id: string, key: string): number | undefined =>
    r.probes.find((p) => p.id === id && p.status === 'done')?.metrics[key];
  const entries: Array<[string, number | undefined]> = [
    ['mips', pick('cpu.multi', 'mips')],
    ['memMiBs', pick('mem.bw', 'mibps')],
    ['rr4kIops', pick('disk.rr4k', 'iops')],
  ];
  const headline = Object.fromEntries(
    entries.filter((e): e is [string, number] => typeof e[1] === 'number'),
  );
  return { id: r.id, host: r.host.name, profile: r.profile, startedAt: r.startedAt, headline };
}
