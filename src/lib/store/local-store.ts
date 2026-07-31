import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createClient, Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BenchResultV1, BenchRunSummary, benchSummary } from '../../bench/bench.model';
import { AppInstallSummary, AppInstallV1, installSummary } from '../../apps/app.model';
import { createInstallsTable, migrateInstallKey } from './install-migration';
import { createMetricsTables } from './metrics-migration';

const SCHEMA_VERSION = 6;

/**
 * Local operational store backed by a standard SQLite file (via libSQL) at
 * ~/.config/vops/profiles/<profile>/vops.db. The schema is raw, ORM-neutral SQL
 * (documented for the future Go port, which reads the same file via
 * modernc.org/sqlite). Secrets never live here — only cache/plans/audit.
 */
@Injectable()
export class LocalStore implements OnModuleDestroy {
  private client: Client | null = null;

  async getCache<T>(key: string): Promise<T | null> {
    const db = await this.db();
    const res = await db.execute({
      sql: 'SELECT value, expires_at FROM cache WHERE key = ?',
      args: [key],
    });
    const row = res.rows[0];
    if (!row) return null;
    if (new Date(String(row.expires_at)).getTime() < Date.now()) return null;
    return JSON.parse(String(row.value)) as T;
  }

  async setCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const db = await this.db();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)',
      args: [key, JSON.stringify(value), expiresAt],
    });
  }

  /** Append-only local audit trail for write operations (never leaves the machine). */
  async appendAudit(action: string, detail: unknown): Promise<void> {
    const db = await this.db();
    await db.execute({
      sql: 'INSERT INTO audit (ts, action, detail) VALUES (?, ?, ?)',
      args: [new Date().toISOString(), action, JSON.stringify(detail)],
    });
  }

  /** Permanent benchmark history (not the expiring cache table). */
  async saveBenchRun(r: BenchResultV1): Promise<void> {
    const db = await this.db();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO bench_runs (id, host, started_at, result) VALUES (?, ?, ?, ?)',
      args: [r.id, r.host.name, r.startedAt, JSON.stringify(r)],
    });
  }

  async getBenchRun(id: string): Promise<BenchResultV1 | null> {
    const db = await this.db();
    const res = await db.execute({ sql: 'SELECT result FROM bench_runs WHERE id = ?', args: [id] });
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.result)) as BenchResultV1) : null;
  }

  async listBenchRuns(host?: string): Promise<BenchRunSummary[]> {
    const db = await this.db();
    const res = host
      ? await db.execute({
          sql: 'SELECT result FROM bench_runs WHERE host = ? ORDER BY started_at DESC',
          args: [host],
        })
      : await db.execute('SELECT result FROM bench_runs ORDER BY started_at DESC');
    return res.rows.map((row) => benchSummary(JSON.parse(String(row.result)) as BenchResultV1));
  }

  /** Deployed app installs (whole record as JSON; secret VALUES never stored). Keyed by
   * `(host, name)`: the same app on two hosts is two installs. */
  async saveInstall(i: AppInstallV1): Promise<void> {
    const db = await this.db();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO app_installs (host, name, app_id, status, updated_at, record) VALUES (?, ?, ?, ?, ?, ?)',
      args: [i.host, i.name, i.appId, i.status, i.updatedAt, JSON.stringify(i)],
    });
  }

  async getInstall(host: string, name: string): Promise<AppInstallV1 | null> {
    const db = await this.db();
    const res = await db.execute({
      sql: 'SELECT record FROM app_installs WHERE host = ? AND name = ?',
      args: [host, name],
    });
    const row = res.rows[0];
    return row ? (JSON.parse(String(row.record)) as AppInstallV1) : null;
  }

  /** Every host carrying an install under this name — one match is unambiguous, more than
   * one has to be resolved by the caller rather than guessed at. */
  async findInstalls(name: string): Promise<AppInstallV1[]> {
    const db = await this.db();
    const res = await db.execute({
      sql: 'SELECT record FROM app_installs WHERE name = ? ORDER BY host',
      args: [name],
    });
    return res.rows.map((row) => JSON.parse(String(row.record)) as AppInstallV1);
  }

  async listInstalls(host?: string): Promise<AppInstallSummary[]> {
    const db = await this.db();
    const res = host
      ? await db.execute({ sql: 'SELECT record FROM app_installs WHERE host = ? ORDER BY updated_at DESC', args: [host] })
      : await db.execute('SELECT record FROM app_installs ORDER BY updated_at DESC');
    return res.rows.map((row) => installSummary(JSON.parse(String(row.record)) as AppInstallV1));
  }

  async deleteInstall(host: string, name: string): Promise<void> {
    const db = await this.db();
    await db.execute({ sql: 'DELETE FROM app_installs WHERE host = ? AND name = ?', args: [host, name] });
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.close();
    this.client = null;
  }

  /** Shared with `MetricsStore`, which owns its own tables but must not open a
   * second connection: two clients on this file would race the migration and
   * double the WAL readers. */
  connection(): Promise<Client> {
    return this.db();
  }

  private async db(): Promise<Client> {
    if (this.client) return this.client;
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dir, 'vops.db');
    this.client = createClient({ url: `file:${dbPath}` });
    // WAL lets a reader (the UI polling installs) run without blocking a writer
    // (a deploy/remove committing) — the default `delete` journal takes a
    // whole-DB lock, so any overlap turned into a SQLITE_BUSY hang. busy_timeout
    // makes the rare residual contention wait briefly instead of failing hard.
    await this.client.execute('PRAGMA journal_mode = WAL');
    await this.client.execute('PRAGMA busy_timeout = 5000');
    await this.migrate(this.client);
    // The file is created with the process umask. It now holds the latest status
    // report per host, which carries source IPs and listening process names.
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
    }
    return this.client;
  }

  private async migrate(db: Client): Promise<void> {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS cache (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         expires_at TEXT NOT NULL
       )`,
    );
    await db.execute(
      `CREATE TABLE IF NOT EXISTS audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         action TEXT NOT NULL,
         detail TEXT NOT NULL
       )`,
    );
    await db.execute(
      `CREATE TABLE IF NOT EXISTS bench_runs (
         id TEXT PRIMARY KEY,
         host TEXT NOT NULL,
         started_at TEXT NOT NULL,
         result TEXT NOT NULL
       )`,
    );
    await db.execute(createInstallsTable('app_installs'));
    await migrateInstallKey(db);
    await createMetricsTables(db);
    await db.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

function profileDir(): string {
  const base =
    process.env.VOPS_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'vops');
  const profile = process.env.VOPS_PROFILE ?? 'default';
  return path.join(base, 'profiles', profile);
}
