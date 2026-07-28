import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VaultAuthError } from '../src/lib/keyring/vault-format';
import {
  LEGACY_ENC_FILE,
  LEGACY_KEY_FILE,
  VAULT_FILE,
  VaultSecrets,
  createVault,
  dropLegacy,
  legacyExists,
  migrateLegacy,
  openVault,
  readHeader,
  vaultExists,
  writeVault,
} from '../src/lib/keyring/vault-store';

const PASSPHRASE = 'correct horse battery staple';

function tempProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vops-vault-'));
}

/** Recreate the store this replaces: AES-256-GCM under a key file beside it. */
function writeLegacy(dir: string, secrets: VaultSecrets): void {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, LEGACY_KEY_FILE), key, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, LEGACY_ENC_FILE),
    `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`,
    { mode: 0o600 },
  );
}

describe('vault lifecycle', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempProfile();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates, seals and reopens', () => {
    const created = createVault(dir, PASSPHRASE);
    expect(vaultExists(dir)).toBe(true);
    writeVault(dir, { tokens: { hetzner: 'tok-1' } }, created.key, created.header);

    const reopened = openVault(dir, PASSPHRASE);
    expect(reopened.secrets.tokens).toEqual({ hetzner: 'tok-1' });
  });

  it('writes the vault 0600 and never stores a key in it', () => {
    createVault(dir, PASSPHRASE);
    const file = path.join(dir, VAULT_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, LEGACY_KEY_FILE))).toBe(false);

    const raw = fs.readFileSync(file, 'utf8');
    const header = JSON.parse(raw);
    expect(Object.keys(header).sort()).toEqual(['data', 'kdf', 'salt', 'user', 'v']);
  });

  it('refuses a wrong passphrase', () => {
    const created = createVault(dir, PASSPHRASE);
    writeVault(dir, { tokens: { scaleway: 's' } }, created.key, created.header);
    expect(() => openVault(dir, 'wrong')).toThrow(VaultAuthError);
  });

  it('gives two profiles different ciphertext for the same secret and passphrase', () => {
    const other = tempProfile();
    try {
      const a = createVault(dir, PASSPHRASE);
      const b = createVault(other, PASSPHRASE);
      expect(readHeader(dir).salt).not.toBe(readHeader(other).salt);
      expect(a.key.equals(b.key)).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses to create over an existing vault', () => {
    createVault(dir, PASSPHRASE);
    expect(() => createVault(dir, PASSPHRASE)).toThrow(/already exists/);
  });

  it('reports a missing vault with an actionable message', () => {
    expect(() => readHeader(dir)).toThrow(/keyring init/);
  });
});

describe('migration from the key-beside-ciphertext store', () => {
  let dir: string;
  const legacy: VaultSecrets = {
    tokens: { hetzner: 'tok-hetzner', scaleway: 'tok-scaleway' },
    credentials: { ovh: { OS_USERNAME: 'u', OS_PASSWORD: 'p' } },
  };

  beforeEach(() => {
    dir = tempProfile();
    writeLegacy(dir, legacy);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('carries every token and credential across', () => {
    const { vault, migrated } = migrateLegacy(dir, PASSPHRASE);
    expect(vault.secrets).toEqual(legacy);
    expect(migrated.sort()).toEqual(['hetzner', 'ovh', 'scaleway']);
    expect(openVault(dir, PASSPHRASE).secrets).toEqual(legacy);
  });

  it('leaves the old files in place until explicitly dropped', () => {
    const { vault } = migrateLegacy(dir, PASSPHRASE);
    expect(legacyExists(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, LEGACY_KEY_FILE))).toBe(true);

    dropLegacy(dir, vault.key);
    expect(legacyExists(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, LEGACY_KEY_FILE))).toBe(false);
    expect(openVault(dir, PASSPHRASE).secrets).toEqual(legacy);
  });

  it('refuses to drop the legacy pair when the new vault cannot be read', () => {
    const { vault } = migrateLegacy(dir, PASSPHRASE);
    const wrongKey = crypto.randomBytes(32);
    expect(() => dropLegacy(dir, wrongKey)).toThrow(VaultAuthError);
    expect(legacyExists(dir)).toBe(true);
    expect(openVault(dir, PASSPHRASE).secrets).toEqual(legacy);

    dropLegacy(dir, vault.key);
    expect(legacyExists(dir)).toBe(false);
  });

  it('refuses when the key file is missing or malformed', () => {
    fs.rmSync(path.join(dir, LEGACY_KEY_FILE));
    expect(() => migrateLegacy(dir, PASSPHRASE)).toThrow(/no \.key/);

    fs.writeFileSync(path.join(dir, LEGACY_KEY_FILE), Buffer.alloc(8));
    expect(() => migrateLegacy(dir, PASSPHRASE)).toThrow(/not a 32-byte key/);
  });

  it('migrates an empty profile into an empty vault', () => {
    const empty = tempProfile();
    try {
      const { vault, migrated } = migrateLegacy(empty, PASSPHRASE);
      expect(vault.secrets).toEqual({});
      expect(migrated).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
