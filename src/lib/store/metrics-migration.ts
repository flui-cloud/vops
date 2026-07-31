import { Client } from '@libsql/client';

/**
 * Local time-series tables for host monitoring. Raw, ORM-neutral SQL like the rest
 * of this store, and self-detecting (`IF NOT EXISTS`) because `user_version` is
 * written but never read — every migration step must be safe to re-run.
 *
 * Nothing here leaves the machine.
 */
export const METRICS_TABLES = [
  `CREATE TABLE IF NOT EXISTS metrics_host (
     host_key   TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     provider   TEXT,
     server_id  TEXT,
     address    TEXT,
     first_seen INTEGER NOT NULL,
     last_seen  INTEGER NOT NULL
   )`,

  // ts is epoch SECONDS as INTEGER, deliberately breaking the ISO-text convention
  // the rest of this schema uses: this is the only range-scanned, pruned table, and
  // string keys cost on every read. WITHOUT ROWID stores rows physically ordered by
  // (host_key, ts), so a seven-day read for one host is a single sequential scan.
  //
  // `mem` is stored already inverted to "used": the raw probe reports available, and
  // having two conventions for one number is how a chart ends up upside down.
  `CREATE TABLE IF NOT EXISTS metrics_sample (
     host_key   TEXT    NOT NULL,
     ts         INTEGER NOT NULL,
     up         INTEGER NOT NULL,
     latency_ms INTEGER,
     cpu        REAL,
     mem        REAL,
     disk       REAL,
     load       REAL,
     cores      INTEGER,
     io         REAL,
     PRIMARY KEY (host_key, ts)
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS metrics_sample_ts ON metrics_sample (ts)`,

  // The ONLY place findings[] is persisted, and it is overwritten rather than
  // accumulated: they carry source IPs (sec.logins) and the names of listening
  // processes (net.listen). A week of that is an archive nobody asked for.
  `CREATE TABLE IF NOT EXISTS metrics_latest (
     host_key   TEXT PRIMARY KEY,
     ts         INTEGER NOT NULL,
     reachable  INTEGER NOT NULL,
     latency_ms INTEGER,
     worst      TEXT NOT NULL,
     depth      TEXT NOT NULL,
     report     TEXT NOT NULL
   )`,
];

export async function createMetricsTables(db: Client): Promise<void> {
  for (const sql of METRICS_TABLES) await db.execute(sql);
}
