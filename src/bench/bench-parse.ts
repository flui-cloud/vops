import { BenchMeta, BenchSample } from './bench.model';

/**
 * Pure parsers for the bench battery output. Each turns one `@@`-section into a
 * number / metrics map. Malformed input never throws — it yields `null` (or a
 * skipped metric upstream), honouring "skip, never guess".
 */
export interface ToolInfo {
  present: boolean;
  path: string;
  version: string;
}

export function parseTools(section: string): Record<string, ToolInfo> {
  const out: Record<string, ToolInfo> = {};
  for (const line of section.split('\n')) {
    if (!line.trim()) continue;
    const [name, pathOrMissing, ...rest] = line.split('\t');
    const key = (name ?? '').trim();
    if (!key) continue;
    const p = (pathOrMissing ?? '').trim();
    const present = p !== '' && p !== 'MISSING';
    out[key] = { present, path: present ? p : '', version: rest.join('\t').trim() };
  }
  return out;
}

export function parseSpaceKb(section: string): number {
  for (const line of section.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const avail = Number(cols[3]);
    if (Number.isFinite(avail)) return avail;
  }
  return NaN;
}

export function parseMeta(section: string, tools: Record<string, ToolInfo>): BenchMeta {
  const kv: Record<string, string> = {};
  for (const line of section.split('\n')) {
    const idx = line.indexOf('\t');
    if (idx < 0) continue;
    kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const memKb = Number(kv.memkb);
  const toolVersions = Object.fromEntries(
    Object.entries(tools)
      .filter(([, v]) => v.present)
      .map(([k, v]) => [k, v.version || v.path]),
  );
  return {
    cpuModel: kv.cpu || 'unknown',
    cores: Number(kv.cores) || 1,
    memGb: Number.isFinite(memKb) ? Math.round((memKb / 1024 / 1024) * 10) / 10 : 0,
    virt: kv.virt || 'unknown',
    kernel: kv.kernel || 'unknown',
    osPretty: kv.os || 'unknown',
    toolVersions,
  };
}

export function parseBaseline(section: string): { load1: number; steal: number } {
  const parts = section.trim().split(/\s+/);
  const load1 = Number(parts[0]);
  const steal = Number(parts[1]);
  return {
    load1: Number.isFinite(load1) ? load1 : 0,
    steal: Number.isFinite(steal) ? steal : 0,
  };
}

/** Total MIPS = the last numeric column of the `Tot:` line of `7z b`. */
export function parse7zMips(section: string): number | null {
  const line = section.split('\n').find((l) => l.trim().startsWith('Tot:'));
  if (!line) return null;
  const nums = line
    .replace('Tot:', '')
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return nums.length ? nums[nums.length - 1] : null;
}

/** openssl `-mr` machine-readable `+F:` rows → bytes/s at the 16384-byte block (last column). */
export function parseOpenssl(section: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of section.split('\n')) {
    if (!line.startsWith('+F:')) continue;
    const cols = line.split(':');
    if (cols.length < 4) continue;
    const name = cols[2].trim();
    const last = Number(cols[cols.length - 1]);
    if (name && Number.isFinite(last)) out[name] = last;
  }
  return out;
}

export function parseSysbenchMiBs(section: string): number | null {
  const line = section.split('\n').find((l) => l.includes('transferred'));
  if (!line) return null;
  const m = /\(([\d.]+)\s*MiB\/sec\)/.exec(line);
  return m ? Number(m[1]) : null;
}

export interface FioMetrics {
  iops: number;
  mbps: number;
  p99ms: number;
}

interface FioSide {
  iops?: number;
  bw_bytes?: number;
  clat_ns?: { percentile?: Record<string, number> };
}
interface FioJob {
  read?: FioSide;
  write?: FioSide;
}
interface FioDoc {
  jobs?: FioJob[];
}

function fioSide(job: FioJob): FioSide | null {
  if (job.read && Number(job.read.iops) > 0) return job.read;
  if (job.write && Number(job.write.iops) > 0) return job.write;
  return job.read ?? job.write ?? null;
}

export function parseFio(section: string): FioMetrics | null {
  let doc: FioDoc;
  try {
    doc = JSON.parse(section) as FioDoc;
  } catch {
    return null;
  }
  const job = doc?.jobs?.[0];
  if (!job) return null;
  const side = fioSide(job);
  if (!side) return null;
  const p99ns = Number(side.clat_ns?.percentile?.['99.000000']) || 0;
  return {
    iops: Number(side.iops) || 0,
    mbps: (Number(side.bw_bytes) || 0) / 1e6,
    p99ms: p99ns / 1e6,
  };
}

export function parseSamples(section: string, probe: string): BenchSample[] {
  const out: BenchSample[] = [];
  for (const line of section.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const t = Number(parts[0]);
    const steal = Number(parts[1]);
    const load1 = Number(parts[2]);
    if ([t, steal, load1].every((n) => Number.isFinite(n))) {
      out.push({ probe, t, steal, load1 });
    }
  }
  return out;
}
