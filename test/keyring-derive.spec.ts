import {
  DEFAULT_KDF,
  KEY_DOMAIN,
  deriveKey,
  deriveMaster,
  newSalt,
} from '../src/lib/keyring/derive';
import {
  VAULT_VERSION,
  VaultAuthError,
  decryptPayload,
  encryptPayload,
  parseVault,
  serializeVault,
} from '../src/lib/keyring/vault-format';

// One derivation is ~90ms; reuse it across assertions instead of re-deriving.
const SALT = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const master = deriveMaster('correct horse battery staple', SALT);

describe('master derivation', () => {
  it('is deterministic for the same passphrase and salt', () => {
    expect(deriveMaster('correct horse battery staple', SALT).equals(master)).toBe(true);
  });

  it('changes with the passphrase and with the salt', () => {
    expect(deriveMaster('another passphrase', SALT).equals(master)).toBe(false);
    expect(deriveMaster('correct horse battery staple', newSalt()).equals(master)).toBe(false);
  });

  it('normalises unicode so the same typed passphrase always unlocks', () => {
    const composed = deriveMaster('passé', SALT); // é
    const decomposed = deriveMaster('passé', SALT); // e + combining acute
    expect(composed.equals(decomposed)).toBe(true);
  });

  it('produces a 32-byte key', () => {
    expect(master).toHaveLength(32);
  });

  it('rejects untrusted KDF parameters from a tampered header', () => {
    expect(() => deriveMaster('x', SALT, { ...DEFAULT_KDF, N: 1024 })).toThrow(/Unsupported scrypt cost/);
    expect(() => deriveMaster('x', SALT, { ...DEFAULT_KDF, N: 65535 })).toThrow(/power of two/);
    expect(() => deriveMaster('x', SALT, { ...DEFAULT_KDF, N: 2 ** 21 })).toThrow(/Unsupported scrypt cost/);
    expect(() => deriveMaster('x', SALT, { ...DEFAULT_KDF, r: 0 })).toThrow(/Unsupported scrypt parameters/);
    expect(() => deriveMaster('x', SALT, { ...DEFAULT_KDF, p: 99 })).toThrow(/Unsupported scrypt parameters/);
  });
});

describe('domain separation', () => {
  const vault = deriveKey(master, KEY_DOMAIN.vault, SALT);
  const session = deriveKey(master, KEY_DOMAIN.session, SALT);
  const dymmi = deriveKey(master, KEY_DOMAIN.dymmi, SALT);

  it('gives every domain a different key', () => {
    expect(vault.equals(session)).toBe(false);
    expect(vault.equals(dymmi)).toBe(false);
    expect(session.equals(dymmi)).toBe(false);
  });

  it('never emits the master itself', () => {
    for (const k of [vault, session, dymmi]) expect(k.equals(master)).toBe(false);
  });

  it('is deterministic, so a restarted process re-derives the same session key', () => {
    expect(deriveKey(master, KEY_DOMAIN.session, SALT).equals(session)).toBe(true);
  });

  it('a leaked session key does not open the vault', () => {
    const sealed = encryptPayload('{"tokens":{"hetzner":"secret"}}', vault);
    expect(() => decryptPayload(sealed, session)).toThrow(VaultAuthError);
  });
});

describe('vault envelope', () => {
  const key = deriveKey(master, KEY_DOMAIN.vault, SALT);

  it('round-trips a payload', () => {
    const sealed = encryptPayload('{"tokens":{"scaleway":"abc"}}', key);
    expect(decryptPayload(sealed, key)).toBe('{"tokens":{"scaleway":"abc"}}');
  });

  it('uses a fresh iv, so the same plaintext never yields the same ciphertext', () => {
    expect(encryptPayload('same', key)).not.toBe(encryptPayload('same', key));
  });

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    const [iv, tag, data] = encryptPayload('{"a":1}', key).split(':');
    const flipped = (Number.parseInt(data.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0');
    expect(() => decryptPayload(`${iv}:${tag}:${flipped}${data.slice(2)}`, key)).toThrow(VaultAuthError);
  });

  it('reports a wrong passphrase as an auth error', () => {
    const sealed = encryptPayload('{"a":1}', key);
    const wrong = deriveKey(deriveMaster('wrong passphrase', SALT), KEY_DOMAIN.vault, SALT);
    expect(() => decryptPayload(sealed, wrong)).toThrow(VaultAuthError);
  });

  it('rejects a malformed payload', () => {
    expect(() => decryptPayload('nope', key)).toThrow(VaultAuthError);
  });
});

describe('vault file parsing', () => {
  const header = { v: VAULT_VERSION, kdf: DEFAULT_KDF, salt: SALT.toString('hex'), user: null };
  const raw = serializeVault(header, encryptPayload('{}', deriveKey(master, KEY_DOMAIN.vault, SALT)));

  it('round-trips the header', () => {
    const file = parseVault(raw);
    expect(file.v).toBe(VAULT_VERSION);
    expect(file.salt).toBe(SALT.toString('hex'));
    expect(file.kdf).toEqual(DEFAULT_KDF);
    expect(file.user).toBeNull();
  });

  it('never writes a key into the file', () => {
    expect(raw).not.toContain(master.toString('hex'));
    expect(raw.toLowerCase()).not.toMatch(/"key"|encryption\.key/);
  });

  it('rejects a tampered or unsupported header', () => {
    expect(() => parseVault(JSON.stringify({ ...header, v: 99, data: 'x' }))).toThrow(/Unsupported vault version/);
    expect(() => parseVault(JSON.stringify({ ...header, salt: 'zz', data: 'x' }))).toThrow(/salt/);
    expect(() => parseVault(JSON.stringify({ ...header, data: '' }))).toThrow(/payload is missing/);
    expect(() => parseVault(JSON.stringify({ ...header, kdf: { algo: 'pbkdf2' }, data: 'x' }))).toThrow(/Unsupported vault KDF/);
    expect(() => parseVault(JSON.stringify({ ...header, kdf: { algo: 'scrypt', N: 'x', r: 8, p: 1 }, data: 'x' }))).toThrow(/malformed/);
    expect(() => parseVault('[]')).toThrow(/not an object/);
  });
});
