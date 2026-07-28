import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The shared secret every keyring client presents, since the transport itself can't
 * be trusted to authenticate cross-platform (POSIX socket modes, Windows pipe DACLs).
 * On Windows this only raises the bar to "same user or root", not above it. */
const COOKIE_FILE = 'keyring.cookie';
const COOKIE_BYTES = 32;

export function keyringCookie(profileDir: string): string {
  const file = path.join(profileDir, COOKIE_FILE);
  const existing = readCookie(file);
  if (existing) return existing;

  const cookie = crypto.randomBytes(COOKIE_BYTES).toString('hex');
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, cookie + '\n', { mode: 0o600 });
  return cookie;
}

/** Forget the cookie, so the next daemon and its clients agree on a fresh one. */
export function resetKeyringCookie(profileDir: string): void {
  fs.rmSync(path.join(profileDir, COOKIE_FILE), { force: true });
}

function readCookie(file: string): string | null {
  try {
    const cookie = fs.readFileSync(file, 'utf8').trim();
    if (!cookie) return null;
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    return cookie;
  } catch {
    return null;
  }
}
