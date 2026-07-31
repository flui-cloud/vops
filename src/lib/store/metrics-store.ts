import { Injectable } from '@nestjs/common';
import { Client, Row } from '@libsql/client';
import { Report, Severity } from '../report';
import { LocalStore } from './local-store';
import { Bucket, Grid, SeriesKey, toGrid, uptimePct } from './metrics-buckets';

export interface MetricSample {
  /** Epoch seconds. */
  ts: number;
  up: 0 | 1;
  latencyMs?: number | null;
  cpu?: number | null;
  /** Already inverted to "used" — see metrics-migration.ts. */
  mem?: number | null;
  disk?: number | null;
  load?: number | null;
  cores?: number | null;
  io?: number | null;
}

export interface HostRef {
  name: string;
  provider?: string;
  providerServerId?: string;
  address?: string;
}

export interface LatestSnapshot {
  hostKey: string;
  name: string;
  ts: number;
  reachable: boolean;
  latencyMs: number | null;
  worst: Severity;
  depth: 'metrics' | 'full';
  report: Report;
}

export interface HistoryResult extends Grid {
  samples: number;
  uptimePct: number | null;
}

export interface PruneResult {
  samples: number;
  hosts: number;
}

/** Belt-and-braces cap: steady state at a 2-minute cadence is ~5k rows per host
 * over seven days, so this only bites if someone sets an absurd interval. */
const PER_HOST_CAP = 20_000;

/**
 * Seven days of host metrics, on this machine, in the same SQLite file as the
 * rest of the local store. Shares `LocalStore`'s connection rather than opening
 * its own.
 */
@Injectable()
export class MetricsStore {
  constructor(private readonly local: LocalStore) {}

  private db(): Promise<Client> {
    return this.local.connection();
  }

  async touchHost(key: string, host: HostRef, at: number): Promise<void> {
    const db = await this.db();
    await db.execute({
      sql: `INSERT INTO metrics_host (host_key, name, provider, server_id, address, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(host_key) DO UPDATE SET
              name = excluded.name, provider = excluded.provider,
              server_id = excluded.server_id, address = excluded.address,
              last_seen = excluded.last_seen`,
      args: [key, host.name, host.provider ?? null, host.providerServerId ?? null, host.address ?? null, at, at],
    });
  }

  /** Move a host's history to a new key — used once, when a pre-uid host is
   * given one, so its series survives instead of starting over. */
  async rekey(from: string, to: string): Promise<void> {
    if (from === to) return;
    const db = await this.db();
    await db.batch(
      [
        { sql: 'UPDATE OR REPLACE metrics_sample SET host_key = ? WHERE host_key = ?', args: [to, from] },
        { sql: 'UPDATE OR REPLACE metrics_latest SET host_key = ? WHERE host_key = ?', args: [to, from] },
        { sql: 'DELETE FROM metrics_host WHERE host_key = ?', args: [from] },
      ],
      'write',
    );
  }

  async record(key: string, s: MetricSample): Promise<void> {
    const db = await this.db();
    await db.execute({
      sql: `INSERT OR REPLACE INTO metrics_sample
              (host_key, ts, up, latency_ms, cpu, mem, disk, load, cores, io)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        key, s.ts, s.up, s.latencyMs ?? null,
        s.cpu ?? null, s.mem ?? null, s.disk ?? null, s.load ?? null, s.cores ?? null, s.io ?? null,
      ],
    });
  }

  async saveLatest(key: string, snap: Omit<LatestSnapshot, 'hostKey' | 'name'>): Promise<void> {
    const db = await this.db();
    await db.execute({
      sql: `INSERT OR REPLACE INTO metrics_latest
              (host_key, ts, reachable, latency_ms, worst, depth, report)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [key, snap.ts, snap.reachable ? 1 : 0, snap.latencyMs, snap.worst, snap.depth, JSON.stringify(snap.report)],
    });
  }

  async latest(keys?: string[]): Promise<LatestSnapshot[]> {
    const db = await this.db();
    const filter = keys?.length ? ` WHERE l.host_key IN (${keys.map(() => '?').join(',')})` : '';
    const res = await db.execute({
      sql: `SELECT l.*, h.name FROM metrics_latest l LEFT JOIN metrics_host h USING (host_key)${filter}`,
      args: keys?.length ? keys : [],
    });
    return res.rows.map(toSnapshot);
  }

  async history(key: string, from: number, to: number, stepSeconds: number): Promise<HistoryResult> {
    const db = await this.db();
    const res = await db.execute({
      // CAST, not bare division: the bound step arrives as a float, which turns
      // integer division into a fractional bucket index that lines up with nothing.
      sql: `SELECT CAST(ts / ? AS INTEGER) AS bucket,
                   AVG(up) AS up, AVG(cpu) AS cpu, AVG(mem) AS mem,
                   AVG(disk) AS disk, AVG(load) AS load, AVG(io) AS io,
                   COUNT(*) AS n
            FROM metrics_sample
            WHERE host_key = ? AND ts >= ? AND ts <= ?
            GROUP BY bucket ORDER BY bucket`,
      args: [stepSeconds, key, from, to],
    });
    const buckets = res.rows.map(toBucket);
    const samples = res.rows.reduce((acc, r) => acc + Number(r.n ?? 0), 0);
    return { ...toGrid(buckets, from, to, stepSeconds), samples, uptimePct: uptimePct(buckets) };
  }

  /**
   * Seven-day window plus a per-host cap. Orphan rows are swept here too, from
   * the live key set the caller just read.
   */
  async prune(retentionDays: number, liveKeys: string[] | null): Promise<PruneResult> {
    const db = await this.db();
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86_400;
    const aged = await db.execute({ sql: 'DELETE FROM metrics_sample WHERE ts < ?', args: [cutoff] });

    const keys = await db.execute('SELECT host_key FROM metrics_host');
    let capped = 0;
    for (const row of keys.rows) {
      const r = await db.execute({
        sql: `DELETE FROM metrics_sample WHERE host_key = ? AND ts < (
                SELECT ts FROM metrics_sample WHERE host_key = ? ORDER BY ts DESC LIMIT 1 OFFSET ?
              )`,
        args: [String(row.host_key), String(row.host_key), PER_HOST_CAP],
      });
      capped += Number(r.rowsAffected ?? 0);
    }

    return { samples: Number(aged.rowsAffected ?? 0) + capped, hosts: await this.sweep(liveKeys) };
  }

  /**
   * Delete history for hosts that no longer exist.
   *
   * `null` means "the caller could not establish the live set" and MUST be a
   * no-op: `hosts.list()` returns [] for an unreadable file, and a sweep that
   * trusted that would delete every host's history on one bad read.
   */
  private async sweep(liveKeys: string[] | null): Promise<number> {
    if (liveKeys === null) return 0;
    const db = await this.db();
    const known = await db.execute('SELECT host_key FROM metrics_host');
    if (!liveKeys.length && known.rows.length) return 0;

    const live = new Set(liveKeys);
    const orphans = known.rows.map((r) => String(r.host_key)).filter((k) => !live.has(k));
    for (const key of orphans) await this.forget(key);
    return orphans.length;
  }

  async forget(key: string): Promise<void> {
    const db = await this.db();
    await db.batch(
      [
        { sql: 'DELETE FROM metrics_sample WHERE host_key = ?', args: [key] },
        { sql: 'DELETE FROM metrics_latest WHERE host_key = ?', args: [key] },
        { sql: 'DELETE FROM metrics_host WHERE host_key = ?', args: [key] },
      ],
      'write',
    );
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : n;
}

function toBucket(r: Row): Bucket {
  const at = (k: SeriesKey): number | null => num(r[k]);
  return {
    bucket: Number(r.bucket),
    up: num(r.up) ?? 0,
    cpu: at('cpu'), mem: at('mem'), disk: at('disk'), load: at('load'), io: at('io'),
  };
}

function toSnapshot(r: Row): LatestSnapshot {
  return {
    hostKey: String(r.host_key),
    name: r.name ? String(r.name) : String(r.host_key),
    ts: Number(r.ts),
    reachable: Number(r.reachable) === 1,
    latencyMs: num(r.latency_ms),
    worst: String(r.worst) as Severity,
    depth: String(r.depth) as 'metrics' | 'full',
    report: JSON.parse(String(r.report)) as Report,
  };
}
