/** The five charted gauges, plus reachability. */
export type SignalKey = 'cpu' | 'mem' | 'disk' | 'load' | 'io';
export type SeriesKey = SignalKey | 'up';

export const SIGNAL_KEYS: SignalKey[] = ['cpu', 'mem', 'disk', 'load', 'io'];
export const SERIES_KEYS: SeriesKey[] = [...SIGNAL_KEYS, 'up'];

export type HistoryRange = '1h' | '6h' | '24h' | '7d';

/**
 * Window and bucket size per range. Chosen so every range lands between ~30 and
 * ~100 points: enough shape to read, few enough that the sparkline stays a line
 * rather than a smear, and small enough that the whole series fits one response.
 */
export const RANGES: Record<HistoryRange, { seconds: number; stepSeconds: number }> = {
  '1h': { seconds: 3_600, stepSeconds: 120 },
  '6h': { seconds: 21_600, stepSeconds: 300 },
  '24h': { seconds: 86_400, stepSeconds: 900 },
  '7d': { seconds: 604_800, stepSeconds: 7_200 },
};

export function isHistoryRange(v: string): v is HistoryRange {
  return v in RANGES;
}

/** One aggregated bucket as it comes back from SQL — sparse, only where data exists. */
export interface Bucket {
  bucket: number;
  up: number;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  load: number | null;
  io: number | null;
}

export interface Grid {
  from: number;
  to: number;
  stepSeconds: number;
  series: Record<SeriesKey, Array<number | null>>;
}

/**
 * Lay sparse buckets onto a regular grid, leaving `null` where nothing was
 * collected. The gaps are the point: a service that was stopped for an hour must
 * read as an hour of no data, not as a straight line joining the two ends.
 */
export function toGrid(buckets: Bucket[], from: number, to: number, stepSeconds: number): Grid {
  const first = Math.floor(from / stepSeconds);
  const count = Math.max(0, Math.floor(to / stepSeconds) - first + 1);
  const byIndex = new Map(buckets.map((b) => [b.bucket - first, b]));

  const series = Object.fromEntries(
    SERIES_KEYS.map((key) => [
      key,
      Array.from({ length: count }, (_, i) => {
        const b = byIndex.get(i);
        return b ? round(b[key]) : null;
      }),
    ]),
  ) as Record<SeriesKey, Array<number | null>>;

  return { from: first * stepSeconds, to: (first + count) * stepSeconds, stepSeconds, series };
}

/**
 * Share of checks that answered, over the buckets that hold any check at all.
 * `null` when nothing was ever collected — which is not the same as 0% up, and
 * showing it as 0% is how a brand-new host looks dead.
 */
export function uptimePct(buckets: Bucket[]): number | null {
  if (!buckets.length) return null;
  const sum = buckets.reduce((acc, b) => acc + b.up, 0);
  return Math.round((sum / buckets.length) * 1000) / 10;
}

function round(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}
