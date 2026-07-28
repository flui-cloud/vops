import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { profileDir } from '../lib/profile';

const TOKEN_FILE = 'session.key';
const TOKEN_BYTES = 24;

/** Persisted per profile (was minted per run, which silently 403'd every already-open
 * tab on restart since the SPA never reloads itself). VOPS_SESSION still wins, for a
 * parent process to hand off a token to a companion tool. */
export function sessionToken(): string {
  const fromEnv = process.env.VOPS_SESSION?.trim();
  if (fromEnv) return fromEnv;

  const dir = profileDir();
  const file = path.join(dir, TOKEN_FILE);
  const existing = readToken(file);
  if (existing) return existing;

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

/** Drop the stored token so the next start mints a fresh one. */
export function resetSessionToken(): void {
  fs.rmSync(path.join(profileDir(), TOKEN_FILE), { force: true });
}

/** Repairs the file mode if something widened it (restore, rsync, careless chmod);
 * unreadable or empty reads mint a new token rather than crashing the UI. */
function readToken(file: string): string | null {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!token) return null;
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    return token;
  } catch {
    return null;
  }
}

/** Compares digests rather than raw buffers: lengths differ freely, and
 * timingSafeEqual throws on a length mismatch — which would itself leak it. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
