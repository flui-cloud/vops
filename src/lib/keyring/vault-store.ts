import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_KDF, KEY_DOMAIN, KeyDomain, deriveKey, deriveMaster, newSalt } from './derive';
import {
  VAULT_VERSION,
  VaultAuthError,
  VaultHeader,
  decryptPayload,
  encryptPayload,
  parseVault,
  serializeVault,
} from './vault-format';

/** The passphrase-derived secret vault: unlike the old `.key`-beside-ciphertext store,
 * the key exists only in memory, so a stolen disk alone yields a sealed vault. */
export interface VaultSecrets {
  tokens?: Record<string, string>;
  credentials?: Record<string, Record<string, string>>;
  /** Environment-style credentials imported out of a plaintext .env. */
  env?: Record<string, string>;
  /** `--set` values behind an approved deploy plan, keyed by plan id. The plan file on disk
   * keeps only a digest of each, so `apply` can still prove the plan is the approved one
   * without a password sitting in a JSON file an agent may read. */
  planSecrets?: Record<string, Record<string, string>>;
}

export interface OpenVault {
  secrets: VaultSecrets;
  /** Vault-domain key; callers re-seal with it. Never the master. */
  key: Buffer;
  header: VaultHeader;
}

export const VAULT_FILE = 'secrets.vault.json';
export const LEGACY_ENC_FILE = 'secrets.json.enc';
export const LEGACY_KEY_FILE = '.key';

export function vaultPath(profileDir: string): string {
  return path.join(profileDir, VAULT_FILE);
}

export function vaultExists(profileDir: string): boolean {
  return fs.existsSync(vaultPath(profileDir));
}

export function legacyExists(profileDir: string): boolean {
  return fs.existsSync(path.join(profileDir, LEGACY_ENC_FILE));
}

/** Create an empty vault sealed with a fresh salt. Fails if one already exists. */
export function createVault(profileDir: string, passphrase: string): OpenVault {
  if (vaultExists(profileDir)) throw new Error(`A vault already exists at ${vaultPath(profileDir)}.`);
  const header: VaultHeader = { v: VAULT_VERSION, kdf: DEFAULT_KDF, salt: newSalt().toString('hex'), user: null };
  const key = vaultKeyFrom(passphrase, header);
  writeVault(profileDir, {}, key, header);
  return { secrets: {}, key, header };
}

export function openVault(profileDir: string, passphrase: string): OpenVault {
  const header = readHeader(profileDir);
  const key = vaultKeyFrom(passphrase, header);
  return { secrets: readWith(profileDir, key), key, header };
}

/** Read the header alone — what the keyring needs to derive without opening. */
export function readHeader(profileDir: string): VaultHeader {
  const file = vaultPath(profileDir);
  if (!fs.existsSync(file)) throw new Error(`No vault at ${file}. Run \`vops keyring init\` first.`);
  return parseVault(fs.readFileSync(file, 'utf8'));
}

/** Derive one domain's key for a header. The master is discarded immediately. */
export function domainKeyFrom(passphrase: string, header: VaultHeader, domain: KeyDomain): Buffer {
  const salt = Buffer.from(header.salt, 'hex');
  const master = deriveMaster(passphrase, salt, header.kdf);
  try {
    return deriveKey(master, domain, salt);
  } finally {
    master.fill(0);
  }
}

/** Derive the vault-domain key for a header. */
export function vaultKeyFrom(passphrase: string, header: VaultHeader): Buffer {
  return domainKeyFrom(passphrase, header, KEY_DOMAIN.vault);
}

export function readWith(profileDir: string, key: Buffer): VaultSecrets {
  const file = parseVault(fs.readFileSync(vaultPath(profileDir), 'utf8'));
  const parsed: unknown = JSON.parse(decryptPayload(file.data, key));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new VaultAuthError('Vault contents are not an object.');
  }
  return parsed as VaultSecrets;
}

export function writeVault(profileDir: string, secrets: VaultSecrets, key: Buffer, header: VaultHeader): void {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(vaultPath(profileDir), serializeVault(header, encryptPayload(JSON.stringify(secrets), key)), {
    mode: 0o600,
  });
}

export interface MigrationResult {
  vault: OpenVault;
  /** Provider ids carried over, for the caller to report. */
  migrated: string[];
}

/** Move a `.key` + `secrets.json.enc` pair into a passphrase-derived vault. The old
 * files are left in place until the caller separately confirms via `dropLegacy`. */
export function migrateLegacy(profileDir: string, passphrase: string): MigrationResult {
  const legacy = readLegacy(profileDir);
  const header: VaultHeader = { v: VAULT_VERSION, kdf: DEFAULT_KDF, salt: newSalt().toString('hex'), user: null };
  const key = vaultKeyFrom(passphrase, header);
  writeVault(profileDir, legacy, key, header);

  // Read back through the same path a later run will use: a migration that
  // "succeeded" but produced an unreadable vault is worse than none.
  const verified = readWith(profileDir, key);
  if (JSON.stringify(verified) !== JSON.stringify(legacy)) {
    throw new Error('Vault migration verification failed — the old store was left untouched.');
  }

  const migrated = [
    ...new Set([...Object.keys(legacy.tokens ?? {}), ...Object.keys(legacy.credentials ?? {})]),
  ];
  return { vault: { secrets: verified, key, header }, migrated };
}

/** Delete the legacy pair. Refuses unless a readable vault is already in place. */
export function dropLegacy(profileDir: string, key: Buffer): void {
  readWith(profileDir, key);
  fs.rmSync(path.join(profileDir, LEGACY_ENC_FILE), { force: true });
  fs.rmSync(path.join(profileDir, LEGACY_KEY_FILE), { force: true });
}

/** Decrypt the old `iv:tag:ciphertext` triple with the key file beside it. */
function readLegacy(profileDir: string): VaultSecrets {
  const encPath = path.join(profileDir, LEGACY_ENC_FILE);
  const keyPath = path.join(profileDir, LEGACY_KEY_FILE);
  if (!fs.existsSync(encPath)) return {};
  if (!fs.existsSync(keyPath)) throw new Error(`Found ${LEGACY_ENC_FILE} but no ${LEGACY_KEY_FILE} to open it with.`);

  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error(`${LEGACY_KEY_FILE} is not a 32-byte key.`);
  const [ivHex, tagHex, dataHex] = fs.readFileSync(encPath, 'utf8').split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error(`${LEGACY_ENC_FILE} is malformed.`);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as VaultSecrets;
}
