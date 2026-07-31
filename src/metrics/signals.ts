import { Finding, Severity } from '../lib/report';
import { HostStatusResult } from '../host-ops/vops-host-status.service';
import { MetricSample } from '../lib/store/metrics-store';
import { SignalKey } from '../lib/store/metrics-buckets';

/**
 * Which finding id feeds which charted signal, best source first.
 *
 * Guest-measured CPU wins because it is normalised 0-100 across cores. `cloud.cpu`
 * is the last resort: the hypervisor reports a share of ONE core, so on a 4-vCPU
 * box it reads up to 400% and is not comparable with the rest.
 *
 * This list used to live in the browser. It is shipped to the dashboard in the
 * metrics response instead of being duplicated there, because two copies of
 * "which id is the CPU" drift the moment one of them gains a source.
 */
export const SIGNAL_IDS: Record<SignalKey, string[]> = {
  cpu: ['sys.cpu', 'agent.cpu', 'cloud.cpu'],
  mem: ['sys.memory', 'agent.mem'],
  disk: ['sys.disk', 'agent.disk'],
  load: ['sys.load'],
  io: ['sys.io'],
};

/**
 * How each signal is named and measured. This travels with the value for the same
 * reason the ids do: the dashboard used to hold its own copy, and a chart labelled
 * from one table while sourced from another is a chart that lies as soon as either
 * moves.
 */
export const SIGNAL_META: Record<SignalKey, { label: string; short: string; unit: string }> = {
  cpu: { label: 'CPU', short: 'CPU', unit: '%' },
  mem: { label: 'Memory used', short: 'Memory', unit: '%' },
  disk: { label: 'Disk used', short: 'Disk', unit: '%' },
  load: { label: 'Load', short: 'Load', unit: '' },
  io: { label: 'Disk I/O', short: 'I/O', unit: 'MB/s' },
};

/** `sys.memory` reports what is *available*; everything downstream wants used. */
const INVERTED = new Set<SignalKey>(['mem']);

export interface SignalValue {
  key: SignalKey;
  label: string;
  /** The same name where a fleet row has room for one word, not three. */
  short: string;
  unit: string;
  value: number;
  /** The check this reading came from, so the UI can link a tile to its check. */
  id: string;
  severity: Severity;
  summary: string;
  cores?: number;
}

function firstNumeric(findings: Finding[], ids: string[]): Finding | null {
  for (const id of ids) {
    const hit = findings.find((f) => f.id === id && f.value != null && Number.isFinite(Number(f.value)));
    if (hit) return hit;
  }
  return null;
}

/** The numeric signals a report carries, in the shape the charts and the store use. */
export function signalsOf(findings: Finding[]): SignalValue[] {
  return (Object.keys(SIGNAL_IDS) as SignalKey[]).flatMap((key) => {
    const found = firstNumeric(findings, SIGNAL_IDS[key]);
    if (!found) return [];
    const raw = Number(found.value);
    const value = INVERTED.has(key) ? Math.max(0, 100 - raw) : raw;
    // "load1 0.54 on 6 core(s)" — the core count is what makes load comparable
    // between a 2-core and a 16-core box, and it only exists in the summary.
    const cores = key === 'load' ? Number(/on (\d+) core/.exec(found.summary ?? '')?.[1]) : Number.NaN;
    return [
      {
        key,
        ...SIGNAL_META[key],
        value: Math.round(value * 100) / 100,
        id: found.id,
        severity: found.severity,
        summary: found.summary,
        ...(Number.isFinite(cores) ? { cores } : {}),
      },
    ];
  });
}

/** One probe result, reduced to the row that gets stored. */
export function sampleFrom(result: HostStatusResult, atMs = Date.now()): MetricSample {
  const byKey = new Map(signalsOf(result.report.findings).map((s) => [s.key, s]));
  const value = (k: SignalKey): number | null => byKey.get(k)?.value ?? null;
  return {
    ts: Math.floor(atMs / 1000),
    up: result.reachable ? 1 : 0,
    latencyMs: Math.round(result.latencyMs) || null,
    cpu: value('cpu'),
    mem: value('mem'),
    disk: value('disk'),
    load: value('load'),
    cores: byKey.get('load')?.cores ?? null,
    io: value('io'),
  };
}
