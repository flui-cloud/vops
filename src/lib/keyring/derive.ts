import * as crypto from 'node:crypto';

/** One passphrase stretched into a master, then HKDF'd per-domain, so a leaked session
 * key can never decrypt the vault. scrypt (not argon2id) needs no native module. */

/** Domain strings. Never reuse one for two purposes; append `:v2` to rotate. */
export const KEY_DOMAIN = {
  /** Encrypts the on-disk secret vault. Must never leave the process. */
  vault: 'vops:secrets:v1',
  /** Signs/validates local-API session cookies. */
  session: 'vops:session:v1',
  /** Encrypts a companion tool's own store (Dymmi), derived from the same master. */
  dymmi: 'dymmi:secrets:v1',
} as const;

export type KeyDomain = (typeof KEY_DOMAIN)[keyof typeof KEY_DOMAIN];

export interface KdfParams {
  algo: 'scrypt';
  /** CPU/memory cost. Memory used is roughly 128 * N * r bytes. */
  N: number;
  r: number;
  p: number;
}

/** ~90ms/~64MiB on an M-series laptop: expensive enough to slow offline guessing
 * without a slow unlock. Stored in the header so it can be raised later. */
export const DEFAULT_KDF: KdfParams = { algo: 'scrypt', N: 65536, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Headroom over the 128*N*r working set; Node's default maxmem (32 MiB) is too low. */
const MAXMEM_FACTOR = 4;

export function newSalt(): Buffer {
  return crypto.randomBytes(SALT_BYTES);
}

/**
 * Stretch the passphrase into the master key. Deliberately synchronous: it runs
 * once per unlock, and the callers are CLI paths where a promise buys nothing.
 */
export function deriveMaster(passphrase: string, salt: Buffer, params: KdfParams = DEFAULT_KDF): Buffer {
  assertParams(params);
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM_FACTOR * 128 * params.N * params.r,
  });
}

/**
 * Derive one purpose-specific key from the master. The domain string is the
 * HKDF `info`, so two domains can never collide even with the same salt.
 */
export function deriveKey(master: Buffer, domain: KeyDomain, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, salt, domain, KEY_BYTES));
}

/** Vault params are user-writable input: guard against a header making scrypt
 * allocate absurd memory or run with a cost too low to be meaningful. */
function assertParams(p: KdfParams): void {
  const powerOfTwo = p.N > 1 && (p.N & (p.N - 1)) === 0;
  if (!powerOfTwo || p.N < 16384 || p.N > 1048576) {
    throw new Error(`Unsupported scrypt cost N=${p.N} (expected a power of two in 2^14..2^20).`);
  }
  if (p.r < 1 || p.r > 32 || p.p < 1 || p.p > 16) {
    throw new Error(`Unsupported scrypt parameters r=${p.r} p=${p.p}.`);
  }
}
