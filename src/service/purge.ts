import * as fs from 'node:fs';
import * as path from 'node:path';
import { configBase, profileDir } from '../lib/profile';

export interface PurgeItem {
  path: string;
  label: string;
  exists: boolean;
  /** Gone for good — no copy of it exists anywhere else, by design. */
  irreplaceable: boolean;
}

export interface PurgePlan {
  profile: string;
  items: PurgeItem[];
}

/**
 * What "delete my data too" actually deletes, enumerated before anything is
 * removed so the user reads a list rather than a promise.
 *
 * Two of these have no backup anywhere by design — that is the whole premise of
 * a local-first tool — so they are marked, and the caller is expected to say so
 * out loud rather than bury it in a confirmation dialog.
 */
export function purgePlan(dir = profileDir(), profile = process.env.VOPS_PROFILE ?? 'default'): PurgePlan {
  const entries: Array<[string, string, boolean]> = [
    ['secrets.vault.json', 'Encrypted credential vault', true],
    ['secrets.json.enc', 'Legacy credential store', true],
    ['.key', 'Legacy store key', true],
    ['keys', 'SSH private keys created by vops', true],
    ['hosts.json', 'Host inventory', false],
    ['vops.db', 'Local store: metrics history, app installs, audit', false],
    ['known_hosts', 'Known SSH host keys', false],
    ['profile-id', 'Profile id (tags this install in authorized_keys)', false],
    ['session.key', 'Dashboard session token', false],
    ['keyring.cookie', 'Keyring cookie', false],
  ];
  return {
    profile,
    items: entries.map(([name, label, irreplaceable]) => {
      const p = path.join(dir, name);
      return { path: p, label, exists: fs.existsSync(p), irreplaceable };
    }),
  };
}

export interface PurgeResult {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Delete this profile's data. Deliberately narrow: it removes the enumerated
 * entries and the WAL sidecars, never `rm -rf` on a directory computed at
 * runtime — a wrong base path there would take the user's home with it.
 */
export function purgeProfile(dir = profileDir()): PurgeResult {
  const plan = purgePlan(dir);
  const targets = plan.items
    .filter((i) => i.exists)
    .flatMap((i) => (i.path.endsWith('vops.db') ? [i.path, `${i.path}-wal`, `${i.path}-shm`] : [i.path]));

  const removed: string[] = [];
  const failed: PurgeResult['failed'] = [];
  for (const p of targets) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (e) {
      failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { removed, failed };
}

/** The log directory is shared by every profile, so it is only offered when the
 * whole config base is going away with it. */
export function logsPath(): string {
  return path.join(configBase(), 'logs');
}
