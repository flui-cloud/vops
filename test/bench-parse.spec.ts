import {
  parse7zMips,
  parseBaseline,
  parseFio,
  parseMeta,
  parseOpenssl,
  parseSamples,
  parseSpaceKb,
  parseSysbenchMiBs,
  parseTools,
} from '../src/bench/bench-parse';

const TOOLS = [
  'fio\t/usr/bin/fio\tfio-3.28',
  'sysbench\t/usr/bin/sysbench\tsysbench 1.0.20',
  '7zz\tMISSING\t',
  '7z\t/usr/bin/7z\t7-Zip 21.07',
  'openssl\t/usr/bin/openssl\tOpenSSL 3.0.2',
].join('\n');

const DF = [
  'Filesystem     1024-blocks     Used Available Capacity Mounted on',
  '/dev/sda1         41251136 12345678  26905458      32% /',
].join('\n');

const META = [
  'kernel\t5.15.0-101-generic',
  'cores\t4',
  'cpu\tIntel(R) Xeon(R) CPU E5-2680 v4',
  'memkb\t8039248',
  'virt\tkvm',
  'os\tUbuntu 22.04.4 LTS',
].join('\n');

const FIO_READ = JSON.stringify({
  jobs: [
    {
      jobname: 'disk.rr4k',
      read: { iops: 45678.12, bw_bytes: 187043840, clat_ns: { percentile: { '99.000000': 420000 } } },
      write: { iops: 0, bw_bytes: 0, clat_ns: { percentile: { '99.000000': 0 } } },
    },
  ],
});

const FIO_WRITE = JSON.stringify({
  jobs: [
    {
      jobname: 'disk.sw1m',
      read: { iops: 0, bw_bytes: 0, clat_ns: { percentile: { '99.000000': 0 } } },
      write: { iops: 512, bw_bytes: 536870912, clat_ns: { percentile: { '99.000000': 1500000 } } },
    },
  ],
});

describe('bench parse — preflight sections', () => {
  it('reads tool presence, path and version (missing marked)', () => {
    const t = parseTools(TOOLS);
    expect(t.fio.present).toBe(true);
    expect(t.fio.version).toBe('fio-3.28');
    expect(t['7zz'].present).toBe(false);
    expect(t['7z'].present).toBe(true);
    expect(t.openssl.present).toBe(true);
  });

  it('extracts available kB from df -Pk', () => {
    expect(parseSpaceKb(DF)).toBe(26905458);
    expect(Number.isNaN(parseSpaceKb('garbage'))).toBe(true);
  });

  it('parses host meta (cores, GB, virt, os)', () => {
    const m = parseMeta(META, parseTools(TOOLS));
    expect(m.cores).toBe(4);
    expect(m.memGb).toBe(7.7);
    expect(m.virt).toBe('kvm');
    expect(m.cpuModel).toBe('Intel(R) Xeon(R) CPU E5-2680 v4');
    expect(m.osPretty).toBe('Ubuntu 22.04.4 LTS');
    expect(m.toolVersions.fio).toBe('fio-3.28');
    expect(m.toolVersions['7zz']).toBeUndefined();
  });

  it('parses baseline load1 + steal', () => {
    expect(parseBaseline('0.30 0.05')).toEqual({ load1: 0.3, steal: 0.05 });
    expect(parseBaseline('')).toEqual({ load1: 0, steal: 0 });
  });
});

describe('bench parse — workload metrics', () => {
  it('takes the last numeric column of the 7z Tot: line (multi + single)', () => {
    const multi = ['Avr:               387   3150  12180', 'Tot:               387   3155  12126'].join('\n');
    const single = ['Tot:               99   3100  3080'].join('\n');
    expect(parse7zMips(multi)).toBe(12126);
    expect(parse7zMips(single)).toBe(3080);
    expect(parse7zMips('no total here')).toBeNull();
  });

  it('reads openssl -mr +F: lines at the 16384-byte column', () => {
    const section = [
      '+H:16:64:256:1024:8192:16384',
      '+F:22:aes-256-gcm:143352530.00:412340230.00:1089344000.00:3400000000.00:4500000000.00:4692934656.00',
      '+F:1:sha256:98765432.00:250000000.00:800000000.00:1500000000.00:2500000000.00:2892934656.00',
    ].join('\n');
    const m = parseOpenssl(section);
    expect(m['aes-256-gcm']).toBe(4692934656);
    expect(m.sha256).toBe(2892934656);
  });

  it('reads sysbench MiB/sec from the transferred line', () => {
    const section = [
      'Total operations: 12300000 (819999.99 per second)',
      '',
      '12011.72 MiB transferred (6825.24 MiB/sec)',
    ].join('\n');
    expect(parseSysbenchMiBs(section)).toBe(6825.24);
    expect(parseSysbenchMiBs('no line')).toBeNull();
  });

  it('reads fio JSON for a read job (iops, MB/s, p99 ms)', () => {
    const f = parseFio(FIO_READ);
    expect(f?.iops).toBeCloseTo(45678.12, 2);
    expect(f?.mbps).toBeCloseTo(187.04, 2);
    expect(f?.p99ms).toBeCloseTo(0.42, 3);
  });

  it('picks the write side for a write job', () => {
    const f = parseFio(FIO_WRITE);
    expect(f?.iops).toBe(512);
    expect(f?.mbps).toBeCloseTo(536.87, 2);
    expect(f?.p99ms).toBeCloseTo(1.5, 3);
  });

  it('returns null on malformed fio output — never throws', () => {
    expect(parseFio('not json at all')).toBeNull();
    expect(parseFio('{"jobs":[]}')).toBeNull();
    expect(() => parseFio('}{')).not.toThrow();
  });

  it('parses sampler lines and skips malformed ones', () => {
    const section = ['1720000000 0.00 0.30', '1720000001 12.50 1.20', 'garbage line', '1720000002 0.10 0.25'].join('\n');
    const samples = parseSamples(section, 'cpu.multi');
    expect(samples).toHaveLength(3);
    expect(samples[1]).toEqual({ probe: 'cpu.multi', t: 1720000001, steal: 12.5, load1: 1.2 });
  });
});
