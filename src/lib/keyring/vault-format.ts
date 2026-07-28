import * as crypto from 'node:crypto';
import { DEFAULT_KDF, KdfParams } from './derive';

/** On-disk vault shape: the header holds everything needed to re-derive the key
 * except the passphrase itself — unlike the old design, the key is never stored. */
export const VAULT_VERSION = 1;

export interface VaultHeader {
  v: number;
  kdf: KdfParams;
  /** Hex; also used as the HKDF salt so every profile derives distinct keys. */
  salt: string;
  /** Reserved for a future multi-operator setup. Unused today. */
  user?: string | null;
}

export interface VaultFile extends VaultHeader {
  data: string;
}

/** Thrown when the payload fails to authenticate — in practice, a wrong passphrase. */
export class VaultAuthError extends Error {
  constructor(message = 'Wrong passphrase (the vault did not authenticate).') {
    super(message);
    this.name = 'VaultAuthError';
  }
}

const IV_BYTES = 12;

export function encryptPayload(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptPayload(payload: string, key: Buffer): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new VaultAuthError('Malformed vault payload.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new VaultAuthError();
  }
}

export function serializeVault(header: VaultHeader, data: string): string {
  const file: VaultFile = { v: header.v, kdf: header.kdf, salt: header.salt, user: header.user ?? null, data };
  return JSON.stringify(file, null, 2) + '\n';
}

/** The vault file is user-writable, so every field is untrusted: a bad header
 * must fail loudly here rather than reach the KDF or the cipher. */
export function parseVault(raw: string): VaultFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('Vault file is not an object.');

  const { v, kdf, salt, data, user } = parsed;
  if (v !== VAULT_VERSION) throw new Error(`Unsupported vault version ${JSON.stringify(v)} (expected ${VAULT_VERSION}).`);
  if (typeof salt !== 'string' || !/^[0-9a-f]{16,}$/i.test(salt)) throw new Error('Vault salt is missing or malformed.');
  if (typeof data !== 'string' || !data) throw new Error('Vault payload is missing.');
  if (user != null && typeof user !== 'string') throw new Error('Vault user field is malformed.');

  return { v, kdf: parseKdf(kdf), salt, data, user: (user as string | null) ?? null };
}

function parseKdf(kdf: unknown): KdfParams {
  if (!isRecord(kdf)) return DEFAULT_KDF;
  if (kdf.algo !== 'scrypt') throw new Error(`Unsupported vault KDF ${JSON.stringify(kdf.algo)}.`);
  const { N, r, p } = kdf;
  if (!isPositiveInt(N) || !isPositiveInt(r) || !isPositiveInt(p)) {
    throw new Error('Vault KDF parameters are malformed.');
  }
  return { algo: 'scrypt', N, r, p };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
