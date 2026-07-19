import { QUIET_PAUSE, SNAPSHOT_PROBE, parseSnapshot, rateFindings } from '../src/host-ops/rate-metrics';

// user nice system idle iowait irq softirq steal guest guest_nice
const STAT_A = 'cpu  1000 100 500 8000 200 10 20 30 999 999';
// Δidle+iowait = 350, Δ(user..steal) = 500 → 30% busy. The guest counters jump by
// 1000 each: counting them would drag the result down to ~14%.
const STAT_B = 'cpu  1100 100 550 8300 250 10 20 30 1999 1999';

// sda is a whole disk (counted); sda1 (partition) and dm-0 carry huge deltas to
// prove they are excluded. sda moves +10240 sectors read and +5120 written.
const DISKS_A = [
  '   8       0 sda 500 10 1000 40 300 8 2000 30 0 60 70',
  '   8       1 sda1 400 10 99000 30 250 6 88000 20 0 40 50',
  ' 253       0 dm-0 100 0 9000 0 90 0 9000 0 0 0 0',
].join('\n');
const DISKS_B = [
  '   8       0 sda 600 12 11240 40 350 8 7120 30 0 60 70',
  '   8       1 sda1 400 10 99500 30 250 6 90000 20 0 40 50',
  ' 253       0 dm-0 100 0 900000 0 90 0 900000 0 0 0 0',
].join('\n');

const snap = (uptime: string, stat: string, disks = DISKS_A): string => `${uptime}\n${stat}\n${disks}`;
const byId = (before: string, after: string): Record<string, ReturnType<typeof rateFindings>[number]> =>
  Object.fromEntries(rateFindings(before, after).map((x) => [x.id, x]));

describe('rate metrics', () => {
  it('reads clock, CPU and disk counters in one snapshot around a quiet pause', () => {
    for (const path of ['/proc/uptime', '/proc/stat', '/proc/diskstats']) {
      expect(SNAPSHOT_PROBE).toContain(path);
    }
    expect(QUIET_PAUSE).toBe('sleep 1');
  });

  it('routes snapshot lines by content, not position', () => {
    const s = parseSnapshot(snap('1000.00', STAT_A));
    expect(s?.uptime).toBe(1000);
    expect(s?.cpu).toEqual({ idle: 8200, total: 9860 });
    expect([...(s?.disks.keys() ?? [])]).toEqual(['sda']);
  });

  describe('sys.cpu', () => {
    it('reports usage normalised across all cores, ignoring the guest counters', () => {
      const cpu = byId(snap('1000.00', STAT_A), snap('1001.00', STAT_B, DISKS_B))['sys.cpu'];
      expect(cpu.severity).toBe('ok');
      expect(cpu.value).toBe(30);
      expect(cpu.summary).toBe('CPU 30.0% used (all cores)');
    });

    it('reports a fully busy core-set as 100, never above', () => {
      const busy = 'cpu  9000 100 500 8000 200 10 20 30';
      expect(byId(snap('1000.00', STAT_A), snap('1001.00', busy))['sys.cpu'].value).toBe(100);
    });

    it('drops only CPU when /proc/stat is unreadable, keeping disk I/O', () => {
      const ids = Object.keys(byId(`1000.00\n${DISKS_A}`, `1001.00\n${DISKS_B}`));
      expect(ids).not.toContain('sys.cpu');
      expect(ids).toContain('sys.io');
    });

    it('drops CPU when the counters went backwards', () => {
      const ids = Object.keys(byId(snap('1000.00', STAT_B), snap('1001.00', STAT_A, DISKS_B)));
      expect(ids).not.toContain('sys.cpu');
      expect(ids).toContain('sys.io');
    });
  });

  describe('sys.io', () => {
    it('computes read/write MB/s over the window, excluding partitions and dm', () => {
      // +10240 and +5120 sectors × 512 B over 5s → 1.0 and 0.5 MB/s (MB = 1024²).
      const io = byId(snap('1000.00', STAT_A), snap('1005.00', STAT_B, DISKS_B))['sys.io'];
      expect(io.summary).toBe('Disk I/O: read 1.0 MB/s · write 0.5 MB/s');
      expect(io.value).toBe(1.5);
    });

    it('drops only disk I/O when a counter went backwards, keeping CPU', () => {
      const ids = Object.keys(byId(snap('1000.00', STAT_A, DISKS_B), snap('1001.00', STAT_B)));
      expect(ids).not.toContain('sys.io');
      expect(ids).toContain('sys.cpu');
    });
  });

  it('yields nothing at all when a snapshot is missing or the window is too short', () => {
    expect(rateFindings(snap('1000.00', STAT_A), '')).toEqual([]);
    expect(rateFindings('', snap('1001.00', STAT_B))).toEqual([]);
    expect(rateFindings(snap('1000.00', STAT_A), snap('1000.50', STAT_B, DISKS_B))).toEqual([]);
  });
});
