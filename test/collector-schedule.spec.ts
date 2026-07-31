import {
  HostSchedule,
  ScheduleConfig,
  dueHosts,
  initialSchedule,
  onManualRefresh,
  onResult,
} from '../src/metrics/collector-schedule';
import { signalsOf, sampleFrom } from '../src/metrics/signals';
import { Finding, buildReport } from '../src/lib/report';

const cfg: ScheduleConfig = { intervalMs: 120_000, fullIntervalMs: 1_800_000 };
const NOW = 1_000_000_000;

function seen(keys: string[], now = NOW): Map<string, HostSchedule> {
  return new Map(keys.map((k) => [k, initialSchedule(k, now, cfg)]));
}

describe('collector schedule', () => {
  it('never fires on first sight, so a fleet does not stampede', () => {
    const schedules = new Map<string, HostSchedule>();
    const hosts = [{ name: 'a', key: 'u:a' }, { name: 'b', key: 'u:b' }];
    expect(dueHosts(schedules, hosts, NOW, cfg)).toEqual([]);
    expect(schedules.size).toBe(2);
  });

  it('spreads first probes across one interval instead of stacking them', () => {
    const starts = ['u:a', 'u:b', 'u:c', 'u:d', 'u:e'].map((k) => initialSchedule(k, NOW, cfg).nextAt - NOW);
    expect(new Set(starts).size).toBeGreaterThan(1);
    for (const s of starts) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(cfg.intervalMs);
    }
  });

  it('runs the cheap probe by default and the full battery on its own clock', () => {
    const schedules = seen(['u:a'], NOW - cfg.intervalMs);
    const hosts = [{ name: 'a', key: 'u:a' }];

    // Never had a full probe → the first due run is a full one.
    expect(dueHosts(schedules, hosts, NOW + cfg.intervalMs, cfg)).toEqual([{ name: 'a', depth: 'full' }]);

    schedules.set('u:a', onResult(schedules.get('u:a')!, 'full', true, NOW, cfg));
    expect(dueHosts(schedules, hosts, NOW + cfg.intervalMs, cfg)).toEqual([{ name: 'a', depth: 'metrics' }]);
    expect(dueHosts(schedules, hosts, NOW + cfg.fullIntervalMs + cfg.intervalMs, cfg))
      .toEqual([{ name: 'a', depth: 'full' }]);
  });

  it('skips a host the user is already refreshing', () => {
    const schedules = seen(['u:a'], NOW - cfg.intervalMs);
    const hosts = [{ name: 'a', key: 'u:a' }];
    expect(dueHosts(schedules, hosts, NOW + cfg.intervalMs, cfg, () => true)).toEqual([]);
  });

  it('backs off on repeated failure but stays shallow enough to notice a recovery', () => {
    let s = initialSchedule('u:a', NOW, cfg);
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const at = NOW + i * 1000;
      s = onResult(s, 'metrics', false, at, cfg);
      gaps.push(s.nextAt - at);
    }
    expect(gaps).toEqual([120_000, 120_000, 240_000, 360_000, 480_000, 480_000]);
    // A host that comes back must reappear within minutes, not half an hour.
    expect(Math.max(...gaps)).toBeLessThanOrEqual(8 * 60_000);
  });

  it('clears the penalty as soon as a probe succeeds', () => {
    let s = onResult(initialSchedule('u:a', NOW, cfg), 'metrics', false, NOW, cfg);
    s = onResult(s, 'metrics', false, NOW, cfg);
    expect(s.failures).toBe(2);
    s = onResult(s, 'metrics', true, NOW, cfg);
    expect(s.failures).toBe(0);
    expect(s.nextAt - NOW).toBe(cfg.intervalMs);
  });

  it('does not reset the deep-check clock on a full probe that failed', () => {
    const s = onResult({ failures: 0, nextAt: 0, lastFullAt: 500 }, 'full', false, NOW, cfg);
    expect(s.lastFullAt).toBe(500);
  });

  it('a manual refresh forgives the backoff', () => {
    let s = initialSchedule('u:a', NOW, cfg);
    for (let i = 0; i < 4; i++) s = onResult(s, 'metrics', false, NOW, cfg);
    s = onManualRefresh(s, NOW, cfg);
    expect(s.failures).toBe(0);
    expect(s.nextAt - NOW).toBe(cfg.intervalMs);
  });
});

describe('signals', () => {
  const report = (findings: Finding[]) => findings;

  it('inverts memory once, on the way in', () => {
    // The probe reports what is available; everything downstream wants used.
    const s = signalsOf(report([{ id: 'sys.memory', severity: 'ok', summary: '72% memory available', value: 72 }]));
    expect(s).toMatchObject([{ key: 'mem', value: 28 }]);
  });

  it('prefers the guest reading over the hypervisor one', () => {
    const s = signalsOf(
      report([
        { id: 'cloud.cpu', severity: 'ok', summary: 'provider', value: 210 },
        { id: 'sys.cpu', severity: 'ok', summary: 'guest', value: 12.7 },
      ]),
    );
    // cloud.cpu is a share of ONE core and would read 210% on a 4-vCPU box.
    expect(s).toMatchObject([{ key: 'cpu', value: 12.7 }]);
  });

  it('falls back through the source list when the better one is missing', () => {
    const s = signalsOf(report([{ id: 'agent.cpu', severity: 'ok', summary: 'agent', value: 5 }]));
    expect(s).toMatchObject([{ key: 'cpu', value: 5 }]);
  });

  it('pulls the core count out of the load summary', () => {
    const s = signalsOf(report([{ id: 'sys.load', severity: 'ok', summary: 'load1 0.54 on 6 core(s)', value: 0.54 }]));
    expect(s).toMatchObject([{ key: 'load', value: 0.54, cores: 6 }]);
  });

  it('reduces a probe to one storable row, seconds not milliseconds', () => {
    const sample = sampleFrom(
      {
        host: 'h',
        latencyMs: 5040,
        reachable: true,
        report: buildReport('h', [
          { id: 'sys.cpu', severity: 'ok', summary: 'cpu', value: 12.7 },
          { id: 'sys.disk', severity: 'ok', summary: 'disk', value: 41 },
        ]),
      },
      1_700_000_500_000,
    );
    expect(sample).toMatchObject({ ts: 1_700_000_500, up: 1, cpu: 12.7, disk: 41, latencyMs: 5040 });
    expect(sample.mem).toBeNull();
  });

  it('records an unreachable host as a real down sample', () => {
    const sample = sampleFrom({ host: 'h', latencyMs: 20_000, reachable: false, report: buildReport('h', []) });
    expect(sample.up).toBe(0);
    expect(sample.cpu).toBeNull();
  });
});
