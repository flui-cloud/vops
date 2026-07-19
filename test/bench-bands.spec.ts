import { bandFor, bandForMetric, diagnostics, readings } from '../src/bench/bench-bands';
import { BenchProbeResult, BenchResultV1 } from '../src/bench/bench.model';

function result(over: Partial<BenchResultV1> = {}): BenchResultV1 {
  return {
    schema: 'vops.bench.v1',
    id: 'b-x',
    profile: 'quick',
    profileVersion: 1,
    mode: 'in-vivo',
    host: { name: 'web1' },
    startedAt: '2026-07-14T09:00:00Z',
    durationMs: 200000,
    meta: { cpuModel: 'x', cores: 4, memGb: 8, virt: 'kvm', kernel: '6', osPretty: 'os', toolVersions: {} },
    baseline: { load1: 0.3, steal: 0.1 },
    runs: 1,
    probes: [],
    samples: [],
    steal: { avg: 0.2, max: 1 },
    warnings: [],
    ...over,
  };
}

const done = (id: string, metrics: Record<string, number>): BenchProbeResult => ({ id, status: 'done', metrics });

describe('bandFor — lower-inclusive boundaries', () => {
  it('singleMips', () => {
    expect(bandFor('singleMips', 1499)).toBe('weak / heavily shared core');
    expect(bandFor('singleMips', 1500)).toBe('entry-level cloud vCPU');
    expect(bandFor('singleMips', 2999)).toBe('entry-level cloud vCPU');
    expect(bandFor('singleMips', 3000)).toBe('typical modern server core');
    expect(bandFor('singleMips', 4499)).toBe('typical modern server core');
    expect(bandFor('singleMips', 4500)).toBe('fast high-clock core');
  });
  it('iops4k', () => {
    expect(bandFor('iops4k', 999)).toBe('HDD-class');
    expect(bandFor('iops4k', 1000)).toBe('basic cloud SSD');
    expect(bandFor('iops4k', 4999)).toBe('basic cloud SSD');
    expect(bandFor('iops4k', 5000)).toBe('capped NVMe (typical cloud QoS)');
    expect(bandFor('iops4k', 19999)).toBe('capped NVMe (typical cloud QoS)');
    expect(bandFor('iops4k', 20000)).toBe('fast NVMe');
    expect(bandFor('iops4k', 99999)).toBe('fast NVMe');
    expect(bandFor('iops4k', 100000)).toBe('top-tier NVMe');
  });
  it('seqMBps', () => {
    expect(bandFor('seqMBps', 149)).toBe('HDD-class');
    expect(bandFor('seqMBps', 150)).toBe('SATA-SSD-class');
    expect(bandFor('seqMBps', 549)).toBe('SATA-SSD-class');
    expect(bandFor('seqMBps', 550)).toBe('NVMe-class (possibly capped)');
    expect(bandFor('seqMBps', 1999)).toBe('NVMe-class (possibly capped)');
    expect(bandFor('seqMBps', 2000)).toBe('fast NVMe');
  });
  it('memMiBs', () => {
    expect(bandFor('memMiBs', 4999)).toBe('constrained');
    expect(bandFor('memMiBs', 5000)).toBe('typical shared DDR4');
    expect(bandFor('memMiBs', 14999)).toBe('typical shared DDR4');
    expect(bandFor('memMiBs', 15000)).toBe('healthy');
    expect(bandFor('memMiBs', 34999)).toBe('healthy');
    expect(bandFor('memMiBs', 35000)).toBe('excellent');
  });
  it('aesBps', () => {
    expect(bandFor('aesBps', 0.49e9)).toBe('no AES acceleration?');
    expect(bandFor('aesBps', 0.5e9)).toBe('older core with AES-NI');
    expect(bandFor('aesBps', 1.99e9)).toBe('older core with AES-NI');
    expect(bandFor('aesBps', 2e9)).toBe('modern AES-NI');
    expect(bandFor('aesBps', 5.99e9)).toBe('modern AES-NI');
    expect(bandFor('aesBps', 6e9)).toBe('very fast crypto');
  });
  it('stealPct', () => {
    expect(bandFor('stealPct', 0.9)).toBe('quiet host');
    expect(bandFor('stealPct', 1)).toBe('some neighbor noise');
    expect(bandFor('stealPct', 4.9)).toBe('some neighbor noise');
    expect(bandFor('stealPct', 5)).toBe('noticeable contention');
    expect(bandFor('stealPct', 14.9)).toBe('noticeable contention');
    expect(bandFor('stealPct', 15)).toBe('heavily oversubscribed');
  });
  it('rejects non-finite values', () => {
    expect(bandFor('singleMips', NaN)).toBeNull();
    expect(bandFor('singleMips', -1)).toBeNull();
  });
});

describe('bandForMetric', () => {
  it('maps metrics to their kinds and never bands cpu.multi or p99', () => {
    expect(bandForMetric('cpu.single', 'mips', 3200)).toBe('typical modern server core');
    expect(bandForMetric('cpu.multi', 'mips', 20000)).toBeNull();
    expect(bandForMetric('cpu.crypto', 'aes-256-gcm', 4.7e9)).toBe('modern AES-NI');
    expect(bandForMetric('cpu.crypto', 'AES-256-GCM', 4.7e9)).toBe('modern AES-NI');
    expect(bandForMetric('cpu.crypto', 'sha256', 4.7e9)).toBeNull();
    expect(bandForMetric('disk.rr4k', 'p99ms', 0.4)).toBeNull();
    expect(bandForMetric('disk.sr1m', 'mbps', 600)).toBe('NVMe-class (possibly capped)');
  });
});

describe('diagnostics', () => {
  it('flags IOPS within 2.5% of a known provider cap, and not outside it', () => {
    const hit = result({ probes: [done('disk.rr4k', { iops: 5100, p99ms: 1 })] });
    expect(diagnostics(hit)).toContain('disk.rr4k ≈ 5000 IOPS — looks like a provider cap');
    const miss = result({ probes: [done('disk.rr4k', { iops: 5300, p99ms: 1 })] });
    expect(diagnostics(miss)).toEqual([]);
  });

  it('flags a disturbed single-thread result (ratio above core count) with the in-vivo baseline', () => {
    const r = result({ probes: [done('cpu.multi', { mips: 12126 }), done('cpu.single', { mips: 2500 })] });
    const d = diagnostics(r);
    expect(d).toHaveLength(1);
    expect(d[0]).toBe(
      'multi/single ratio 4.9× on 4 cores — single-thread result likely disturbed (in-vivo baseline load1 0.3); treat single-core as a floor',
    );
  });

  it('flags poor multi-core scaling and omits the in-vivo note in clean-room mode', () => {
    const r = result({
      mode: 'clean-room',
      probes: [done('cpu.multi', { mips: 4000 }), done('cpu.single', { mips: 2500 })],
    });
    expect(diagnostics(r)).toEqual(['multi-core scaling 1.6× on 4 cores — shared or throttled vCPUs likely']);
  });

  it('stays silent on a normal ratio', () => {
    const r = result({ probes: [done('cpu.multi', { mips: 9750 }), done('cpu.single', { mips: 2500 })] });
    expect(diagnostics(r)).toEqual([]);
  });

  it('flags an unstable metric at spreadPct >= 20 with the worst spread', () => {
    const unstable = result({
      runs: 3,
      probes: [{
        id: 'disk.rr4k',
        status: 'done',
        metrics: { iops: 9000, p99ms: 2 },
        spread: {
          iops: { min: 7000, max: 9200, spreadPct: 24.4, n: 3 },
          p99ms: { min: 1.8, max: 2.2, spreadPct: 20, n: 3 },
        },
      }],
    });
    expect(diagnostics(unstable)).toEqual([
      'disk.rr4k varies ±24.4% across 3 runs — unstable under repetition',
    ]);
    const stable = result({
      runs: 3,
      probes: [{
        id: 'disk.rr4k',
        status: 'done',
        metrics: { iops: 9000 },
        spread: { iops: { min: 8600, max: 9200, spreadPct: 6.7, n: 3 } },
      }],
    });
    expect(diagnostics(stable)).toEqual([]);
  });

  it('flags steal at avg >= 5 only', () => {
    expect(diagnostics(result({ steal: { avg: 5, max: 9 } }))).toEqual([
      'CPU steal avg 5% — noisy neighbors during the run',
    ]);
    expect(diagnostics(result({ steal: { avg: 4.9, max: 9 } }))).toEqual([]);
  });
});

describe('readings', () => {
  it('bands each done probe by its primary metric plus the steal average', () => {
    const r = result({
      probes: [
        done('cpu.multi', { mips: 12126 }),
        done('cpu.single', { mips: 3100 }),
        done('disk.rr4k', { iops: 45678, p99ms: 0.4 }),
        { id: 'mem.bw', status: 'skipped', note: 'tool missing: sysbench', metrics: {} },
      ],
      steal: { avg: 0.2, max: 1 },
    });
    const rd = readings(r);
    expect(rd.bandsVersion).toBe(1);
    expect(rd.bands['cpu.multi']).toBeNull();
    expect(rd.bands['cpu.single']).toBe('typical modern server core');
    expect(rd.bands['disk.rr4k']).toBe('fast NVMe');
    expect(rd.bands['mem.bw']).toBeUndefined();
    expect(rd.bands.steal).toBe('quiet host');
  });
});
