import { BenchProbeResult, BenchResultV1 } from './bench.model';

/**
 * Interpretive bands v1 — coarse technology classes per metric, never a ranking
 * and never a composite score. Thresholds are lower-inclusive and frozen per
 * BANDS_VERSION; every artifact prints the version next to the profile version.
 * cpu.multi is deliberately not banded (total MIPS depends on core count).
 */
export const BANDS_VERSION = 1;

export type BandKind = 'singleMips' | 'iops4k' | 'seqMBps' | 'memMiBs' | 'aesBps' | 'stealPct';

const BAND_TABLE: Record<BandKind, Array<[number, string]>> = {
  singleMips: [
    [0, 'weak / heavily shared core'],
    [1500, 'entry-level cloud vCPU'],
    [3000, 'typical modern server core'],
    [4500, 'fast high-clock core'],
  ],
  iops4k: [
    [0, 'HDD-class'],
    [1000, 'basic cloud SSD'],
    [5000, 'capped NVMe (typical cloud QoS)'],
    [20000, 'fast NVMe'],
    [100000, 'top-tier NVMe'],
  ],
  seqMBps: [
    [0, 'HDD-class'],
    [150, 'SATA-SSD-class'],
    [550, 'NVMe-class (possibly capped)'],
    [2000, 'fast NVMe'],
  ],
  memMiBs: [
    [0, 'constrained'],
    [5000, 'typical shared DDR4'],
    [15000, 'healthy'],
    [35000, 'excellent'],
  ],
  aesBps: [
    [0, 'no AES acceleration?'],
    [0.5e9, 'older core with AES-NI'],
    [2e9, 'modern AES-NI'],
    [6e9, 'very fast crypto'],
  ],
  stealPct: [
    [0, 'quiet host'],
    [1, 'some neighbor noise'],
    [5, 'noticeable contention'],
    [15, 'heavily oversubscribed'],
  ],
};

export function bandFor(kind: BandKind, value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  let label: string | null = null;
  for (const [min, name] of BAND_TABLE[kind]) {
    if (value >= min) label = name;
  }
  return label;
}

export function bandForMetric(probeId: string, key: string, value: number): string | null {
  if (probeId === 'cpu.single' && key === 'mips') return bandFor('singleMips', value);
  if (probeId === 'mem.bw' && key === 'mibps') return bandFor('memMiBs', value);
  if (probeId === 'cpu.crypto' && key.toLowerCase().includes('aes')) return bandFor('aesBps', value);
  if (key === 'iops') return bandFor('iops4k', value);
  if (key === 'mbps') return bandFor('seqMBps', value);
  return null;
}

const IOPS_CAPS = [3000, 5000, 6000, 10000, 15000, 20000, 50000, 100000];

function metricOf(r: BenchResultV1, id: string, key: string): number | null {
  const p = r.probes.find((x) => x.id === id && x.status === 'done');
  const v = p?.metrics[key];
  return typeof v === 'number' ? v : null;
}

function capNotes(r: BenchResultV1): string[] {
  return ['disk.rr4k', 'disk.rw4k'].flatMap((id) => {
    const iops = metricOf(r, id, 'iops');
    if (iops == null) return [];
    const cap = IOPS_CAPS.find((c) => Math.abs(iops - c) <= c * 0.025);
    return cap == null ? [] : [`${id} ≈ ${cap} IOPS — looks like a provider cap`];
  });
}

function ratioNotes(r: BenchResultV1): string[] {
  const multi = metricOf(r, 'cpu.multi', 'mips');
  const single = metricOf(r, 'cpu.single', 'mips');
  const cores = r.meta.cores;
  if (multi == null || single == null || single <= 0 || cores <= 0) return [];
  const ratio = multi / single;
  const rx = ratio.toFixed(1);
  if (ratio > cores * 1.05) {
    const invivo = r.mode === 'in-vivo' ? ` (in-vivo baseline load1 ${r.baseline.load1})` : '';
    return [
      `multi/single ratio ${rx}× on ${cores} cores — single-thread result likely disturbed${invivo}; treat single-core as a floor`,
    ];
  }
  if (cores > 1 && ratio < cores * 0.6) {
    return [`multi-core scaling ${rx}× on ${cores} cores — shared or throttled vCPUs likely`];
  }
  return [];
}

function spreadNotes(r: BenchResultV1): string[] {
  return r.probes.flatMap((p) => {
    const entries = Object.values(p.spread ?? {});
    if (!entries.length) return [];
    const worst = entries.reduce((m, s) => (s.spreadPct > m.spreadPct ? s : m), entries[0]);
    return worst.spreadPct >= 20
      ? [`${p.id} varies ±${worst.spreadPct}% across ${worst.n} runs — unstable under repetition`]
      : [];
  });
}

/** Honest, reason-always-visible notes about the run's conditions. */
export function diagnostics(r: BenchResultV1): string[] {
  return [
    ...capNotes(r),
    ...ratioNotes(r),
    ...spreadNotes(r),
    ...(r.steal.avg >= 5 ? [`CPU steal avg ${r.steal.avg}% — noisy neighbors during the run`] : []),
  ];
}

function probeBand(p: BenchProbeResult): string | null {
  if (p.id === 'cpu.multi') return null;
  for (const [k, v] of Object.entries(p.metrics)) {
    const band = bandForMetric(p.id, k, v);
    if (band) return band;
  }
  return null;
}

export interface BenchReading {
  bandsVersion: number;
  bands: Record<string, string | null>;
  diagnostics: string[];
}

/** Per-probe bands (plus 'steal') and diagnostics — the API/UI reading surface. */
export function readings(r: BenchResultV1): BenchReading {
  const bands = Object.fromEntries([
    ...r.probes
      .filter((p) => p.status === 'done')
      .map((p): [string, string | null] => [p.id, probeBand(p)]),
    ['steal', bandFor('stealPct', r.steal.avg)],
  ]);
  return { bandsVersion: BANDS_VERSION, bands, diagnostics: diagnostics(r) };
}
