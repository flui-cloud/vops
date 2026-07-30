import { Client } from '@libsql/client';

const COLUMNS = 'host, name, app_id, status, updated_at, record';
const STAGING = 'app_installs_v5';

/** `(host, name)` — the same app name on two hosts is two installs, not one. */
export function createInstallsTable(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
     host TEXT NOT NULL,
     name TEXT NOT NULL,
     app_id TEXT NOT NULL,
     status TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     record TEXT NOT NULL,
     PRIMARY KEY (host, name)
   )`;
}

/**
 * v4 → v5: `app_installs` was keyed by `name` alone, so installing an app on a second
 * host overwrote the first host's record. SQLite cannot alter a primary key, so the
 * table is rebuilt — copy into a staging table, verify the row count, and only then
 * swap. Losing an install record is worse than the collision this fixes, so a short
 * copy is never trusted: the original stays in place until the copy is proven whole.
 * Idempotent: re-running against an already-keyed table is a no-op.
 */
export async function migrateInstallKey(db: Client): Promise<void> {
  if (await isKeyedByHostAndName(db)) return;

  const before = await countRows(db, 'app_installs');
  await db.execute(`DROP TABLE IF EXISTS ${STAGING}`);
  await db.execute(createInstallsTable(STAGING));
  await db.execute(`INSERT INTO ${STAGING} (${COLUMNS}) SELECT ${COLUMNS} FROM app_installs`);

  const copied = await countRows(db, STAGING);
  if (copied !== before) {
    await db.execute(`DROP TABLE IF EXISTS ${STAGING}`);
    throw new Error(
      `app_installs migration copied ${copied} of ${before} install records — the original table is untouched.`,
    );
  }
  await db.batch(['DROP TABLE app_installs', `ALTER TABLE ${STAGING} RENAME TO app_installs`], 'write');
}

async function isKeyedByHostAndName(db: Client): Promise<boolean> {
  const info = await db.execute('PRAGMA table_info(app_installs)');
  const key = info.rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
  return key.length === 2 && key[0] === 'host' && key[1] === 'name';
}

async function countRows(db: Client, table: string): Promise<number> {
  const res = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(res.rows[0].n);
}
