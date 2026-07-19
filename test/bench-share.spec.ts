import { formatMetricsInline, renderCompareShare, renderShare } from '../src/bench/bench-share';
import { BenchResultV1 } from '../src/bench/bench.model';
import { CompareRow } from '../src/bench/bench-compare';

// The host these numbers came from — its address/user/port must NEVER surface in
// the paste-ready artifact (structural sanitization: renderShare only sees the alias).
const HOST_ADDRESS = '203.0.113.7';
const HOST_USER = 'deploy';
const HOST_PORT = '2222';

const RESULT: BenchResultV1 = {
  schema: 'vops.bench.v1',
  id: 'b-xyz789',
  profile: 'quick',
  profileVersion: 1,
  mode: 'in-vivo',
  host: { name: 'web1' },
  startedAt: '2026-07-14T09:15:00.000Z',
  durationMs: 194000,
  meta: {
    cpuModel: 'Intel(R) Xeon(R) CPU E5-2680 v4',
    cores: 4,
    memGb: 7.7,
    virt: 'kvm',
    kernel: '5.15.0-101-generic',
    osPretty: 'Ubuntu 22.04.4 LTS',
    toolVersions: { fio: 'fio-3.28' },
  },
  baseline: { load1: 0.3, steal: 0.05 },
  probes: [
    { id: 'cpu.multi', status: 'done', metrics: { mips: 12126 } },
    { id: 'cpu.crypto', status: 'done', metrics: { 'aes-256-gcm': 4692934656, sha256: 2892934656 } },
    { id: 'disk.rr4k', status: 'done', metrics: { iops: 45678, p99ms: 0.42 } },
    { id: 'disk.sr1m', status: 'done', metrics: { mbps: 536.87 } },
    { id: 'mem.bw', status: 'skipped', note: 'tool missing: sysbench', metrics: {} },
  ],
  samples: [],
  runs: 1,
  steal: { avg: 0.2, max: 1.1 },
  warnings: ['baseline load1 0.3 on 4 core(s) — results are in-vivo'],
};

describe('bench share renderer', () => {
  const md = renderShare(RESULT);

  it('renders the alias title, profile v1 and the reproduce line with the bands version', () => {
    expect(md).toContain('## vops bench — web1');
    expect(md).toContain('quick (v1)');
    expect(md).toContain(
      'Reproduce: vops bench host web1 --profile quick   (vops bench profile v1 · bands v1)',
    );
  });

  it('renders the in-vivo baseline, metrics, steal and skipped probes', () => {
    expect(md).toContain('in-vivo (baseline load1 0.3, steal 0.05%)');
    expect(md).toContain('| cpu.multi | MIPS | 12126 |');
    expect(md).toContain('CPU steal: avg 0.2% · max 1.1% — quiet host');
    expect(md).toContain('Skipped: mem.bw (tool missing: sysbench)');
    expect(md).toContain('> baseline load1 0.3 on 4 core(s) — results are in-vivo');
  });

  it('adds a reading column with bands (empty for unbanded metrics)', () => {
    expect(md).toContain('| probe | metric | value | reading |');
    expect(md).toContain('| cpu.multi | MIPS | 12126 |  |');
    expect(md).toContain('| cpu.crypto | aes-256-gcm | 4.69 GB/s | modern AES-NI |');
    expect(md).toContain('| disk.rr4k | IOPS | 45678 | fast NVMe |');
    expect(md).toContain('| disk.sr1m | throughput | 537 MB/s | SATA-SSD-class |');
  });

  it('renders diagnostics as quoted notes before the footer', () => {
    const capped = renderShare({
      ...RESULT,
      probes: [...RESULT.probes, { id: 'disk.rw4k', status: 'done', metrics: { iops: 5050, p99ms: 1.2 } }],
    });
    expect(capped).toContain('> disk.rw4k ≈ 5000 IOPS — looks like a provider cap');
  });

  it('renders spread and the median-of-N footer for repeated runs', () => {
    const repeated = renderShare({
      ...RESULT,
      runs: 3,
      probes: [
        {
          id: 'disk.rr4k',
          status: 'done',
          metrics: { iops: 9996, p99ms: 8.09 },
          spread: { iops: { min: 9100, max: 10400, spreadPct: 13, n: 3 } },
        },
      ],
    });
    expect(repeated).toContain('| disk.rr4k | IOPS | 9996 (±13%, n=3) |');
    expect(repeated).toContain('· bands v1 · median of 3 runs)');
  });

  it('never leaks the host address, user or port', () => {
    expect(md).not.toContain(HOST_ADDRESS);
    expect(md).not.toContain(HOST_USER);
    expect(md).not.toContain(HOST_PORT);
  });

  it('formats a metrics map inline for the CLI', () => {
    expect(formatMetricsInline({ iops: 45678, p99ms: 0.42 })).toBe('IOPS 45678 · clat p99 0.42 ms');
  });
});

describe('compare share renderer', () => {
  const row = (over: Partial<CompareRow>): CompareRow => ({
    key: 'cpu.multi', label: 'CPU multi (MIPS)', a: 10000, b: 11000, deltaPct: 10, better: 'up', ...over,
  });
  const cmp = {
    rows: [
      row({}),
      row({ key: 'mem.bw', label: 'Memory (MiB/s)', a: 27182, b: 27000, deltaPct: -0.7 }),
      row({ key: 'aes', label: 'AES (GB/s)', a: null, b: null, deltaPct: null }),
      row({ key: 'rr4k.p99', label: '4k read p99 (ms)', a: 8.09, b: 4.05, deltaPct: -50, better: 'down' as const }),
    ],
    caveats: ['different profiles — durations differ, treat deltas with care'],
    a: { id: 'b-aaa', host: 'web1', startedAt: '2026-07-10T09:00:00Z', profile: 'quick' },
    b: { id: 'b-bbb', host: 'web2', startedAt: '2026-07-14T09:00:00Z', profile: 'full' },
  };
  const md = renderCompareShare(cmp);

  it('renders the subject-first title and the table header', () => {
    expect(md).toContain('## vops bench compare — web2 2026-07-14 vs web1 2026-07-10');
    expect(md).toContain('| metric | baseline | this run | Δ |');
  });

  it('renders caveats as quoted lines', () => {
    expect(md).toContain('> different profiles — durations differ, treat deltas with care');
  });

  it('formats deltas: signed, ≈ inside the noise band, and — for null', () => {
    expect(md).toContain('| CPU multi (MIPS) | 10,000 | 11,000 | +10.0% |');
    expect(md).toContain('| Memory (MiB/s) | 27,182 | 27,000 | ≈ -0.7% |');
    expect(md).toContain('| AES (GB/s) | — | — | — |');
    expect(md).toContain('| 4k read p99 (ms) | 8.09 | 4.05 | -50.0% |');
  });

  it('renders the reproduce footer with both ids', () => {
    expect(md).toContain('Reproduce: vops bench compare b-aaa b-bbb');
  });
});
