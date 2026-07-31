import { BatteryDepth } from '../host-ops/status-battery';

export interface ScheduleConfig {
  /** Cheap metrics probe cadence, per host. */
  intervalMs: number;
  /** Full battery cadence, per host. */
  fullIntervalMs: number;
}

export interface HostSchedule {
  failures: number;
  nextAt: number;
  lastFullAt: number;
}

export interface DueHost {
  name: string;
  depth: BatteryDepth;
}

/**
 * Backoff multiplier after N consecutive failures, capped at 4 cycles (~8 min at
 * the default cadence). Deliberately shallow: probing a host that is down costs
 * one `ssh` that times out — no load on the host, since it isn't answering — and
 * a machine that comes back should reappear in the dashboard within minutes, not
 * within half an hour.
 */
const BACKOFF = [1, 1, 2, 3, 4];

/** Indexed by failures-1: the first miss is retried at the normal cadence, since
 * a single dropped probe is usually a blip and not worth slowing down for. */
function backoffFor(failures: number): number {
  if (failures <= 0) return 1;
  return BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)];
}

/** Deterministic 0..n-1 from a host key, to stagger first probes. */
function spread(key: string, n: number): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
  return n > 0 ? h % n : 0;
}

/**
 * First sight of a host: due immediately would mean every host in the fleet
 * firing on the same second forever after. Spread them across one interval.
 */
export function initialSchedule(key: string, now: number, cfg: ScheduleConfig): HostSchedule {
  return { failures: 0, nextAt: now + spread(key, cfg.intervalMs), lastFullAt: 0 };
}

export function dueHosts(
  schedules: Map<string, HostSchedule>,
  hosts: Array<{ name: string; key: string }>,
  now: number,
  cfg: ScheduleConfig,
  isBusy: (name: string) => boolean = () => false,
): DueHost[] {
  return hosts.flatMap(({ name, key }) => {
    const s = schedules.get(key);
    if (!s) {
      schedules.set(key, initialSchedule(key, now, cfg));
      return [];
    }
    if (now < s.nextAt) return [];
    // A probe the user just asked for is already running; take it next tick, by
    // which time a fresh sample is recorded anyway.
    if (isBusy(name)) return [];
    return [{ name, depth: now - s.lastFullAt >= cfg.fullIntervalMs ? ('full' as const) : ('metrics' as const) }];
  });
}

export function onResult(s: HostSchedule, depth: BatteryDepth, ok: boolean, now: number, cfg: ScheduleConfig): HostSchedule {
  const failures = ok ? 0 : s.failures + 1;
  return {
    failures,
    nextAt: now + cfg.intervalMs * backoffFor(failures),
    // Only a full probe that actually answered resets the deep-check clock: a
    // failed one collected none of those checks.
    lastFullAt: depth === 'full' && ok ? now : s.lastFullAt,
  };
}

/** A manual refresh clears the penalty — the user has new information. */
export function onManualRefresh(s: HostSchedule, now: number, cfg: ScheduleConfig): HostSchedule {
  return { ...s, failures: 0, nextAt: now + cfg.intervalMs };
}
