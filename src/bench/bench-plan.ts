import { VopsHost } from '../hosts/host.model';
import {
  BenchMeta,
  BenchProbeResult,
  BenchProfile,
  BenchResultV1,
  BenchSample,
  PROFILE_VERSION,
} from './bench.model';
import { PROBE_SPECS, ProbeId, ProbeSpec, expectedSeconds } from './bench-scripts';
import {
  ToolInfo,
  parse7zMips,
  parseFio,
  parseOpenssl,
  parseSysbenchMiBs,
} from './bench-parse';

/**
 * Pure planning + result-assembly for the bench service: which probes will run
 * given the detected tools/space, per-probe metric extraction, and building the
 * final `BenchResultV1`. Kept out of the service so it stays unit-testable.
 */
export interface ProbePlan {
  id: ProbeId;
  tool: string;
  willRun: boolean;
  reason?: string;
}

export const fioSizeKb = (profile: BenchProfile): number =>
  profile === 'full' ? 1024 * 1024 : 512 * 1024;

export const clampRuns = (n?: number): number =>
  Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n as number))) : 1;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const median = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Median per metric across the done rounds; min/max spread attached when n > 1. */
export function aggregateProbeRounds(rounds: BenchProbeResult[]): BenchProbeResult {
  const done = rounds.filter((r) => r.status === 'done');
  if (!done.length) {
    const last = rounds[rounds.length - 1];
    return { id: last.id, status: 'skipped', note: last.note, metrics: {} };
  }
  const keys = [...new Set(done.flatMap((r) => Object.keys(r.metrics)))];
  const metrics: Record<string, number> = {};
  const spread: BenchProbeResult['spread'] = {};
  for (const k of keys) {
    const vals = done
      .map((r) => r.metrics[k])
      .filter((v) => Number.isFinite(v))
      .sort((x, y) => x - y);
    if (!vals.length) continue;
    const med = median(vals);
    metrics[k] = med;
    if (vals.length > 1) {
      const min = vals[0];
      const max = vals[vals.length - 1];
      const spreadPct = med > 0 ? Math.round(((max - min) / med) * 1000) / 10 : 0;
      spread[k] = { min, max, spreadPct, n: vals.length };
    }
  }
  return {
    id: done[0].id,
    status: 'done',
    metrics,
    ...(Object.keys(spread).length ? { spread } : {}),
  };
}

function toolPresent(spec: ProbeSpec, tools: Record<string, ToolInfo>): boolean {
  if (spec.tool === 'sevenz') return !!(tools['7zz']?.present || tools['7z']?.present);
  return !!tools[spec.tool]?.present;
}

const toolLabel = (tool: string): string => (tool === 'sevenz' ? '7z' : tool);

export function probePlan(
  spec: ProbeSpec,
  tools: Record<string, ToolInfo>,
  spaceOk: boolean,
  needKb: number,
): ProbePlan {
  if (!toolPresent(spec, tools)) {
    return { id: spec.id, tool: spec.tool, willRun: false, reason: `tool missing: ${toolLabel(spec.tool)}` };
  }
  if (spec.tool === 'fio' && !spaceOk) {
    return {
      id: spec.id,
      tool: spec.tool,
      willRun: false,
      reason: `insufficient free space (need ${Math.ceil(needKb / 1024)} MiB)`,
    };
  }
  return { id: spec.id, tool: spec.tool, willRun: true };
}

export interface ProfileEstimate {
  estSeconds: number;
  needKb: number;
  spaceOk: boolean;
}

/** Per-profile duration/space numbers from one preflight — pure in (tools, freeKb). */
export function profileEstimates(
  tools: Record<string, ToolInfo>,
  freeKb: number,
): Record<BenchProfile, ProfileEstimate> {
  const forProfile = (profile: BenchProfile): ProfileEstimate => {
    const needKb = 2 * fioSizeKb(profile);
    const spaceOk = Number.isFinite(freeKb) && freeKb >= needKb;
    const estSeconds = PROBE_SPECS.map((spec) => probePlan(spec, tools, spaceOk, needKb))
      .filter((p) => p.willRun)
      .reduce((sum, p) => sum + expectedSeconds(p.id, profile), 0);
    return { estSeconds, needKb, spaceOk };
  };
  return { quick: forProfile('quick'), full: forProfile('full') };
}

export function missingTools(tools: Record<string, ToolInfo>): string[] {
  const present = (bin: string): boolean => !!tools[bin]?.present;
  const sevenz = present('7zz') || present('7z');
  return [
    ...(sevenz ? [] : ['7z']),
    ...(present('openssl') ? [] : ['openssl']),
    ...(present('sysbench') ? [] : ['sysbench']),
    ...(present('fio') ? [] : ['fio']),
  ];
}

export function extractMetrics(id: ProbeId, raw: string): Record<string, number> | null {
  if (id === 'cpu.multi' || id === 'cpu.single') {
    const mips = parse7zMips(raw);
    return mips == null ? null : { mips };
  }
  if (id === 'cpu.crypto') {
    const m = parseOpenssl(raw);
    return Object.keys(m).length ? m : null;
  }
  if (id === 'mem.bw') {
    const v = parseSysbenchMiBs(raw);
    return v == null ? null : { mibps: v };
  }
  const f = parseFio(raw);
  if (!f) return null;
  if (id === 'disk.rr4k' || id === 'disk.rw4k') return { iops: f.iops, p99ms: f.p99ms };
  return { mbps: f.mbps };
}

function buildWarnings(
  baseline: { load1: number; steal: number },
  cores: number,
  stealAvg: number,
): string[] {
  return [
    ...(baseline.load1 >= cores
      ? [`baseline load1 ${round2(baseline.load1)} on ${cores} core(s) — results are in-vivo`]
      : []),
    ...(stealAvg > 5
      ? [`elevated CPU steal ${round2(stealAvg)}% — noisy neighbour, treat CPU numbers as a floor`]
      : []),
  ];
}

export interface AssembleInput {
  host: VopsHost;
  profile: BenchProfile;
  startedAt: string;
  durationMs: number;
  meta: BenchMeta;
  baseline: { load1: number; steal: number };
  runs: number;
  probes: BenchProbeResult[];
  samples: BenchSample[];
}

export function assembleResult(input: AssembleInput): BenchResultV1 {
  const steals = input.samples.map((s) => s.steal);
  const stealAvg = steals.length ? steals.reduce((a, b) => a + b, 0) / steals.length : 0;
  const stealMax = steals.length ? Math.max(...steals) : 0;
  return {
    schema: 'vops.bench.v1',
    id: `b-${Date.now().toString(36)}`,
    profile: input.profile,
    profileVersion: PROFILE_VERSION,
    mode: 'in-vivo',
    host: { name: input.host.name },
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    meta: input.meta,
    baseline: input.baseline,
    runs: input.runs,
    probes: input.probes,
    samples: input.samples,
    steal: { avg: round2(stealAvg), max: round2(stealMax) },
    warnings: buildWarnings(input.baseline, input.meta.cores, stealAvg),
  };
}
