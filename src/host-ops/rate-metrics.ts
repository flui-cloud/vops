import { Finding } from '../lib/report';

/**
 * CPU and disk throughput for the `host status` battery. Neither can be read from a
 * single snapshot, so the probe is sampled twice around a short quiet pause.
 *
 * `sys.cpu` is normalised across all cores (0-100), the definition node_exporter
 * and the vops agent use, so it is comparable across providers and against external
 * monitoring. The provider-plane `cloud.cpu` is a share of ONE core (0-400% on a
 * 4-vCPU server) and is only the no-SSH fallback.
 *
 * The pause is why this does not reuse the battery's own elapsed time, which would
 * be free: the battery's probes (two 24h journalctl scans, `apt-get -s upgrade`,
 * `ss`) are heavy enough to dominate the reading, so vops ends up measuring itself —
 * idle hosts reported ~30% CPU and tens of MB/s of disk reads. The cost is a spot
 * sample that averages down sub-second bursts, which is the right bias for a live
 * view: under-reporting a spike beats inventing load that is really our own.
 */
export const SNAPSHOT_PROBE =
  "cut -d' ' -f1 /proc/uptime 2>/dev/null; grep '^cpu ' /proc/stat 2>/dev/null; cat /proc/diskstats 2>/dev/null";

/** Separates the two snapshots. Long enough to measure, short enough not to stall. */
export const QUIET_PAUSE = 'sleep 1';

const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
const IO_MB = 1024 * 1024;
const MIN_WINDOW = 0.7;
// user nice system idle iowait irq softirq steal. `guest`/`guest_nice` follow but
// Linux already counts them inside user/nice — summing them inflates the
// denominator and under-reports usage on virtualised hosts.
const CPU_FIELDS = 8;
const CPU_IDLE = new Set([3, 4]); // idle + iowait

interface CpuSample {
  idle: number;
  total: number;
}

interface Snapshot {
  uptime: number;
  cpu: CpuSample | null;
  disks: Map<string, { read: number; write: number }>;
}

/**
 * One snapshot: the leading /proc/uptime field (the measurement clock), the
 * aggregate /proc/stat line, then raw /proc/diskstats. Lines are routed by content
 * rather than position, so a host missing any one of the three still yields the
 * metrics it can support.
 */
export function parseSnapshot(text: string): Snapshot | null {
  const lines = text.split('\n');
  const uptime = Number((lines[0] ?? '').trim());
  if (!Number.isFinite(uptime)) return null;
  const disks = new Map<string, { read: number; write: number }>();
  let cpu: CpuSample | null = null;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('cpu ')) {
      cpu ??= parseCpuLine(trimmed);
      continue;
    }
    // Per whole-disk device (partitions and dm excluded) sectors_read is field
    // index 5 and sectors_written index 9, 0-based after trimming.
    const cols = trimmed.split(/\s+/);
    if (cols.length < 10 || !WHOLE_DISK.test(cols[2])) continue;
    const read = Number(cols[5]);
    const write = Number(cols[9]);
    if (Number.isFinite(read) && Number.isFinite(write)) disks.set(cols[2], { read, write });
  }
  return { uptime, cpu, disks };
}

function parseCpuLine(line: string): CpuSample | null {
  const cols = line.split(/\s+/).slice(1, 1 + CPU_FIELDS);
  if (cols.length < CPU_FIELDS) return null;
  let idle = 0;
  let total = 0;
  for (const [i, col] of cols.entries()) {
    const v = Number(col);
    if (!Number.isFinite(v)) return null;
    total += v;
    if (CPU_IDLE.has(i)) idle += v;
  }
  return { idle, total };
}

/**
 * Findings derived from the two snapshots. Any gap in the data — a missing or
 * malformed snapshot, backwards counters, or too short a window — drops the
 * affected finding rather than reporting a misleading zero.
 */
export function rateFindings(before: string, after: string): Finding[] {
  const a = parseSnapshot(before);
  const b = parseSnapshot(after);
  if (!a || !b || b.uptime - a.uptime < MIN_WINDOW) return [];
  const cpu = cpuFinding(a.cpu, b.cpu);
  const io = ioFinding(a, b, b.uptime - a.uptime);
  return [...(cpu ? [cpu] : []), ...(io ? [io] : [])];
}

function cpuFinding(a: CpuSample | null, b: CpuSample | null): Finding | null {
  if (!a || !b) return null;
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0 || dIdle < 0) return null;
  const pct = Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
  const value = Math.round(pct * 10) / 10;
  return { id: 'sys.cpu', severity: 'ok', summary: `CPU ${value.toFixed(1)}% used (all cores)`, value };
}

function ioFinding(a: Snapshot, b: Snapshot, window: number): Finding | null {
  let matched = 0;
  let readBytes = 0;
  let writeBytes = 0;
  for (const [name, end] of b.disks) {
    const start = a.disks.get(name);
    if (!start) continue;
    const dRead = end.read - start.read;
    const dWrite = end.write - start.write;
    if (dRead < 0 || dWrite < 0) return null;
    matched += 1;
    readBytes += dRead * 512;
    writeBytes += dWrite * 512;
  }
  if (!matched) return null;
  const readMb = readBytes / window / IO_MB;
  const writeMb = writeBytes / window / IO_MB;
  return {
    id: 'sys.io',
    severity: 'ok',
    summary: `Disk I/O: read ${readMb.toFixed(1)} MB/s · write ${writeMb.toFixed(1)} MB/s`,
    value: Math.round((readMb + writeMb) * 10) / 10,
  };
}
