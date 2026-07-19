import { aggregateProbeRounds, clampRuns, profileEstimates } from '../src/bench/bench-plan';
import { ToolInfo } from '../src/bench/bench-parse';
import { BenchProbeResult } from '../src/bench/bench.model';
import { PROBE_SPECS, expectedSeconds } from '../src/bench/bench-scripts';

const tool = (present: boolean): ToolInfo => ({ present, path: present ? '/usr/bin/x' : '', version: '' });

const allTools = (): Record<string, ToolInfo> => ({
  fio: tool(true),
  sysbench: tool(true),
  '7zz': tool(true),
  '7z': tool(false),
  openssl: tool(true),
});

const sum = (profile: 'quick' | 'full', ids: string[]): number =>
  PROBE_SPECS.filter((s) => ids.includes(s.id)).reduce((n, s) => n + expectedSeconds(s.id, profile), 0);

const ALL = PROBE_SPECS.map((s) => s.id);
const NON_DISK = ALL.filter((id) => !id.startsWith('disk.'));

describe('profileEstimates', () => {
  it('returns both profiles with their own needKb and estSeconds', () => {
    const est = profileEstimates(allTools(), 10 * 1024 * 1024);
    expect(est.quick).toEqual({ estSeconds: sum('quick', ALL), needKb: 2 * 512 * 1024, spaceOk: true });
    expect(est.full).toEqual({ estSeconds: sum('full', ALL), needKb: 2 * 1024 * 1024, spaceOk: true });
  });

  it('flips spaceOk per profile between the two thresholds and drops disk probes from full only', () => {
    const est = profileEstimates(allTools(), 1.5 * 1024 * 1024);
    expect(est.quick.spaceOk).toBe(true);
    expect(est.full.spaceOk).toBe(false);
    expect(est.quick.estSeconds).toBe(sum('quick', ALL));
    expect(est.full.estSeconds).toBe(sum('full', NON_DISK));
  });

  it('excludes probes for missing tools from both estimates', () => {
    const tools = { ...allTools(), fio: tool(false) };
    const est = profileEstimates(tools, 10 * 1024 * 1024);
    expect(est.quick.estSeconds).toBe(sum('quick', NON_DISK));
    expect(est.full.estSeconds).toBe(sum('full', NON_DISK));
  });

  it('treats unknown free space as not ok', () => {
    const est = profileEstimates(allTools(), NaN);
    expect(est.quick.spaceOk).toBe(false);
    expect(est.full.spaceOk).toBe(false);
  });
});

const done = (metrics: Record<string, number>): BenchProbeResult => ({ id: 'disk.rr4k', status: 'done', metrics });
const skipped = (note: string): BenchProbeResult => ({ id: 'disk.rr4k', status: 'skipped', note, metrics: {} });

describe('aggregateProbeRounds', () => {
  it('takes the median of an odd number of rounds with exact spread math', () => {
    const agg = aggregateProbeRounds([done({ iops: 1000 }), done({ iops: 1200 }), done({ iops: 1100 })]);
    expect(agg.status).toBe('done');
    expect(agg.metrics.iops).toBe(1100);
    expect(agg.spread?.iops).toEqual({ min: 1000, max: 1200, spreadPct: 18.2, n: 3 });
  });

  it('averages the two middle values for an even number of rounds', () => {
    const agg = aggregateProbeRounds([done({ iops: 100 }), done({ iops: 300 }), done({ iops: 200 }), done({ iops: 400 })]);
    expect(agg.metrics.iops).toBe(250);
    expect(agg.spread?.iops).toEqual({ min: 100, max: 400, spreadPct: 120, n: 4 });
  });

  it('uses only done rounds and keeps their n', () => {
    const agg = aggregateProbeRounds([done({ iops: 1000 }), skipped('malformed output'), done({ iops: 1400 })]);
    expect(agg.status).toBe('done');
    expect(agg.metrics.iops).toBe(1200);
    expect(agg.spread?.iops?.n).toBe(2);
  });

  it('omits spread at n=1 and reports all-skipped with the last note', () => {
    const single = aggregateProbeRounds([done({ iops: 900 })]);
    expect(single.metrics.iops).toBe(900);
    expect(single.spread).toBeUndefined();
    const none = aggregateProbeRounds([skipped('tool missing: fio'), skipped('still missing')]);
    expect(none.status).toBe('skipped');
    expect(none.note).toBe('still missing');
  });
});

describe('clampRuns', () => {
  it('clamps to 1..5 and defaults to 1', () => {
    expect(clampRuns(undefined)).toBe(1);
    expect(clampRuns(0)).toBe(1);
    expect(clampRuns(3)).toBe(3);
    expect(clampRuns(9)).toBe(5);
    expect(clampRuns(NaN)).toBe(1);
  });
});
