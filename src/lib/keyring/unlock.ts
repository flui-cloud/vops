import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { profileDir as defaultProfileDir } from '../profile';
import { KEY_DOMAIN, KeyDomain } from './derive';
import { companionDomain } from './companion';
import { KeyringResponse, isKeyringError } from './protocol';
import { keyringRequest } from './keyring-client';
import { keyringCookie } from './keyring-cookie';
import { promptSecret } from './prompt';
import { keyringSocket } from './socket-path';
import { VaultAuthError } from './vault-format';
import { VaultLockedError, clearVaultKey, setVaultKey, vaultKey } from './vault-session';
import { domainKeyFrom, readHeader, readWith, vaultExists, vaultKeyFrom } from './vault-store';

/** Progressive unlock: the vault opens only when a secret is actually read, never at
 * boot, so credential-free commands (compare, bench, the map) never prompt. Degrades
 * legacy → cached key → VOPS_PASSPHRASE → keyring daemon → local derivation. */
export const PASSPHRASE_ENV = 'VOPS_PASSPHRASE';

export type VaultMode = 'legacy' | 'unlocked';

export interface UnlockOptions {
  dir?: string;
  /** Supplied by `vops keyring unlock`; otherwise asked for at the terminal. */
  passphrase?: string;
  /** Derive here and now, without involving a keyring. */
  noDaemon?: boolean;
  /** Go through the keyring even with the passphrase in hand — `vops keyring unlock`
   * wants to leave a session for the next process, not just open this one. */
  useDaemon?: boolean;
  /** `false` = open only from what is already at hand (this process, VOPS_PASSPHRASE,
   * a keyring that is already running); a still-sealed vault answers VaultLockedError
   * instead of a prompt. For reads whose credential is optional. */
  interactive?: boolean;
}

const SPAWN_POLL_MS = 100;
const SPAWN_TIMEOUT_MS = 4_000;

let promptAllowed = true;

/** The local API calls this so an HTTP request needing a credential fails fast as a
 * 423, instead of printing "passphrase:" into a terminal the browser can't see. */
export function disablePrompting(): void {
  promptAllowed = false;
}

export async function ensureVaultUnlocked(opts: UnlockOptions = {}): Promise<VaultMode> {
  const dir = opts.dir ?? defaultProfileDir();
  if (!vaultExists(dir)) return 'legacy';
  if (vaultKey()) return 'unlocked';

  // A passphrase we already hold short-circuits the keyring: there is nothing to
  // ask, and nothing to keep a session for. `useDaemon` opts back in.
  const given = opts.passphrase ?? process.env[PASSPHRASE_ENV]?.trim();
  if (given && !opts.useDaemon) {
    adopt(dir, vaultKeyFrom(given, readHeader(dir)));
    return 'unlocked';
  }

  adopt(dir, await resolveKey(dir, opts, given));
  return 'unlocked';
}

/** Accepts a key only after it opens the vault, so a wrong VOPS_PASSPHRASE fails
 * here rather than three calls later inside an unrelated provider command. */
export function adopt(dir: string, key: Buffer): void {
  const secrets = readWith(dir, key);
  setVaultKey(key);
  applyVaultEnv(secrets.env);
}

/** Publishes vault-held env credentials into this process. An existing value always
 * wins, so a plaintext `.env` override can never be changed by what's in the vault. */
export function applyVaultEnv(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const pending = Object.entries(env).filter(([name, value]) => value && !process.env[name]);
  for (const [name, value] of pending) process.env[name] = value;
  return pending.map(([name]) => name);
}

export interface KeyringStatus {
  listening: boolean;
  unlocked: boolean;
  expiresAt: number | null;
}

export async function keyringStatus(dir = defaultProfileDir()): Promise<KeyringStatus> {
  const res = await ask(keyringSocket(dir).socketPath, { op: 'status', cookie: keyringCookie(dir) });
  if (!res) return { listening: false, unlocked: false, expiresAt: null };
  if (res.ok && res.op === 'status') {
    return { listening: true, unlocked: res.unlocked, expiresAt: res.expiresAt };
  }
  return { listening: true, unlocked: false, expiresAt: null };
}

/** Derive a companion tool's own key from the same master. Deliberately not cached
 * in this process: it belongs to another program, which holds it for its own life. */
export async function companionKey(name: string, dir = defaultProfileDir()): Promise<Buffer> {
  const domain = companionDomain(name);
  if (!vaultExists(dir)) {
    throw new Error('This profile is not sealed, so there is no master to derive from. Run: vops keyring init');
  }
  return resolveKey(dir, { dir }, process.env[PASSPHRASE_ENV]?.trim(), domain);
}

/** Forget the key here and in the daemon. Returns whether a daemon answered. */
export async function lockKeyring(dir = defaultProfileDir()): Promise<boolean> {
  clearVaultKey();
  const res = await ask(keyringSocket(dir).socketPath, { op: 'lock', cookie: keyringCookie(dir) });
  return Boolean(res?.ok);
}

async function resolveKey(
  dir: string,
  opts: UnlockOptions,
  given?: string,
  domain: KeyDomain = KEY_DOMAIN.vault,
): Promise<Buffer> {
  const socket = keyringSocket(dir).socketPath;
  const cookie = keyringCookie(dir);
  const interactive = opts.interactive !== false;

  if (!opts.noDaemon) {
    const cached = await cachedKey(dir, socket, cookie, domain, interactive);
    if (cached) return cached;
  }

  if (!given && (!promptAllowed || !interactive)) throw new VaultLockedError();
  const passphrase = given ?? (await promptSecret('vops vault passphrase: '));
  if (!opts.noDaemon) {
    const fresh = await unlockDaemon(socket, cookie, passphrase, domain);
    if (fresh) return fresh;
  }
  const header = readHeader(dir);
  // The daemon proves a passphrase before handing out any key; this path has no
  // such check. For the vault domain the caller's `adopt` catches a typo, but a
  // companion key never round-trips through the vault — a wrong one would only
  // surface later, as the companion's own store failing to decrypt.
  if (domain !== KEY_DOMAIN.vault) readWith(dir, vaultKeyFrom(passphrase, header));
  return domainKeyFrom(passphrase, header, domain);
}

/** Ask a running keyring for a derived key, starting one if none is listening. A
 * probe that will not prompt starts none: with no passphrase to follow, a fresh
 * daemon holds nothing to answer with. */
async function cachedKey(
  dir: string,
  socket: string,
  cookie: string,
  domain: KeyDomain,
  allowSpawn = true,
): Promise<Buffer | null> {
  const first = await keyOp(socket, cookie, domain);
  if (first) return first;
  if (!allowSpawn) return null;
  if (await isListening(socket, cookie)) return null;
  if (!(await startDaemon(dir, socket, cookie))) return null;
  return keyOp(socket, cookie, domain);
}

async function keyOp(socket: string, cookie: string, domain: KeyDomain): Promise<Buffer | null> {
  const res = await ask(socket, { op: 'key', cookie, domain });
  if (res?.ok && res.op === 'key') return Buffer.from(res.key, 'hex');
  return null;
}

async function unlockDaemon(
  socket: string,
  cookie: string,
  passphrase: string,
  domain: KeyDomain,
): Promise<Buffer | null> {
  const unlocked = await ask(socket, { op: 'unlock', cookie, passphrase });
  if (!unlocked) return null;
  if (isKeyringError(unlocked)) {
    // A daemon that is present but rejects the passphrase is a real answer, not
    // a reason to fall back to local derivation with the same wrong input. It is
    // typed, not a plain Error, so callers can tell a bad passphrase apart from
    // an unreadable vault without matching on message text.
    if (unlocked.code === 'bad-passphrase') throw new VaultAuthError(unlocked.error);
    return null;
  }
  return keyOp(socket, cookie, domain);
}

/** `null` means "no keyring answered"; a response means it did, ok or not. */
async function ask(socket: string, req: Parameters<typeof keyringRequest>[1]): Promise<KeyringResponse | null> {
  try {
    return await keyringRequest(socket, req);
  } catch {
    return null;
  }
}

async function isListening(socket: string, cookie: string): Promise<boolean> {
  return (await ask(socket, { op: 'status', cookie })) !== null;
}

/** Spawns `daemon-main.js` directly (skipping the oclif tree, so the wait is just a
 * Node start). Returns false when absent (e.g. running from sources under jest). */
async function startDaemon(dir: string, socket: string, cookie: string): Promise<boolean> {
  const entry = path.join(__dirname, 'daemon-main.js');
  if (!fs.existsSync(entry)) return false;

  const child = spawn(process.execPath, [entry, dir], { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isListening(socket, cookie)) return true;
    await delay(SPAWN_POLL_MS);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
