import { compareRuns } from '../src/bench/bench-compare';
import { BenchProbeResult, BenchResultV1 } from '../src/bench/bench.model';

const done = (id: string, metrics: Record<string, number>): BenchProbeResult => ({ id, status: 'done', metrics });

function run(over: Partial<BenchResultV1> = {}): BenchResultV1 {
  return {
    schema: 'vops.bench.v1',
    id: 'b-a',
    profile: 'quick',
    profileVersion: 1,
    mode: 'clean-room',
    host: { name: 'web1' },
    startedAt: '2026-07-14T09:00:00Z',
    durationMs: 200000,
    meta: { cpuModel: 'x', cores: 4, memGb: 8, virt: 'kvm', kernel: '6', osPretty: 'os', toolVersions: {} },
    baseline: { load1: 0.2, steal: 0 },
    probes: [
      done('cpu.multi', { mips: 10000 }),
      done('cpu.single', { mips: 2500 }),
      done('mem.bw', { mibps: 12000 }),
      done('cpu.crypto', { 'aes-256-gcm': 4e9, sha256: 2e9 }),
      done('disk.rr4k', { iops: 20000, p99ms: 0.5 }),
      done('disk.rw4k', { iops: 10000, p99ms: 1 }),
      done('disk.sr1m', { mbps: 800 }),
      done('disk.sw1m', { mbps: 400 }),
    ],
    samples: [],
    runs: 1,
    steal: { avg: 0.1, max: 0.5 },
    warnings: [],
    ...over,
  };
}

const rowByKey = (res: ReturnType<typeof compareRuns>, key: string) =>
  res.rows.find((r) => r.key === key);

describe('compareRuns', () => {
  it('computes deltas as (b-a)/a*100 with the declared better direction', () => {
    const b = run({
      id: 'b-b',
      probes: [
        done('cpu.multi', { mips: 11000 }),
        done('cpu.single', { mips: 2500 }),
        done('mem.bw', { mibps: 6000 }),
        done('cpu.crypto', { 'AES-256-GCM': 8e9 }),
        done('disk.rr4k', { iops: 20000, p99ms: 0.25 }),
        done('disk.rw4k', { iops: 5000, p99ms: 2 }),
        done('disk.sr1m', { mbps: 800 }),
        done('disk.sw1m', { mbps: 500 }),
      ],
    });
    const res = compareRuns(run(), b);
    expect(res.rows).toHaveLength(10);
    expect(rowByKey(res, 'cpu.multi')).toMatchObject({ a: 10000, b: 11000, deltaPct: 10, better: 'up' });
    expect(rowByKey(res, 'mem.bw')?.deltaPct).toBeCloseTo(-50);
    expect(rowByKey(res, 'aes')).toMatchObject({ a: 4, b: 8, deltaPct: 100, better: 'up' });
    expect(rowByKey(res, 'rr4k.p99')).toMatchObject({ deltaPct: -50, better: 'down' });
    expect(rowByKey(res, 'rw4k.p99')).toMatchObject({ deltaPct: 100, better: 'down' });
    expect(rowByKey(res, 'sw1m')?.deltaPct).toBeCloseTo(25);
  });

  it('yields null values and null delta for skipped or missing probes', () => {
    const a = run({ probes: [done('cpu.multi', { mips: 10000 })] });
    const b = run({ id: 'b-b', probes: [done('cpu.multi', { mips: 10000 }), done('mem.bw', { mibps: 9000 })] });
    const res = compareRuns(a, b);
    expect(rowByKey(res, 'mem.bw')).toMatchObject({ a: null, b: 9000, deltaPct: null });
    expect(rowByKey(res, 'aes')).toMatchObject({ a: null, b: null, deltaPct: null });
    expect(rowByKey(res, 'cpu.multi')?.deltaPct).toBe(0);
  });

  it('caveats a profile mismatch', () => {
    const res = compareRuns(run(), run({ id: 'b-b', profile: 'full' }));
    expect(res.caveats).toContain('different profiles — durations differ, treat deltas with care');
  });

  it('caveats mismatched run counts (missing runs reads as 1)', () => {
    const res = compareRuns(run({ runs: 3 }), run({ id: 'b-b' }));
    expect(res.caveats).toContain('different run counts (3 vs 1) — medians vs single samples');
    const old = run();
    delete (old as Partial<BenchResultV1>).runs;
    expect(compareRuns(old, run({ id: 'b-b' })).caveats).toEqual([]);
  });

  it('caveats a profile version mismatch as not comparable', () => {
    const b = run({ id: 'b-b' });
    (b as { profileVersion: number }).profileVersion = 2;
    const res = compareRuns(run(), b);
    expect(res.caveats.some((c) => c.includes('different profile versions (v1 vs v2) — NOT comparable'))).toBe(true);
  });

  it('caveats each in-vivo side with its baseline', () => {
    const a = run({ mode: 'in-vivo', baseline: { load1: 1.4, steal: 0.2 } });
    const b = run({ id: 'b-b', host: { name: 'web2' }, mode: 'in-vivo', baseline: { load1: 0.6, steal: 0 } });
    const res = compareRuns(a, b);
    expect(res.caveats).toContain('web1 (A) measured in-vivo (baseline load1 1.4) — its numbers are floors');
    expect(res.caveats).toContain('web2 (B) measured in-vivo (baseline load1 0.6) — its numbers are floors');
    expect(compareRuns(run(), run({ id: 'b-b' })).caveats).toEqual([]);
  });
});
