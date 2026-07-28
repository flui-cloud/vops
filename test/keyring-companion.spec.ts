import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COMPANION_NAMES, companionDomain } from '../src/lib/keyring/companion';
import { DEFAULT_KDF, KEY_DOMAIN, deriveKey, deriveMaster } from '../src/lib/keyring/derive';
import { PASSPHRASE_ENV, companionKey } from '../src/lib/keyring/unlock';
import { VAULT_VERSION, VaultAuthError, VaultHeader } from '../src/lib/keyring/vault-format';
import { createVault, domainKeyFrom, readHeader, vaultKeyFrom } from '../src/lib/keyring/vault-store';

const SALT = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const header: VaultHeader = { v: VAULT_VERSION, kdf: DEFAULT_KDF, salt: SALT.toString('hex'), user: null };
const PASSPHRASE = 'correct horse battery staple';

describe('companion whitelist', () => {
  it('resolves a known companion to its key domain', () => {
    expect(companionDomain('dymmi')).toBe(KEY_DOMAIN.dymmi);
  });

  it("refuses vops's own domains, so the command can't become an oracle for them", () => {
    for (const name of ['vault', 'session', 'vops:secrets:v1', 'vops:session:v1']) {
      expect(() => companionDomain(name)).toThrow(/Unknown companion/);
    }
  });

  it('refuses inherited object properties', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => companionDomain(name)).toThrow(/Unknown companion/);
    }
  });

  it('exposes only companions, never a vops domain', () => {
    expect(COMPANION_NAMES).toEqual(['dymmi']);
  });
});

describe('domainKeyFrom', () => {
  it('agrees with the daemon, which derives from the master for the same salt', () => {
    const master = deriveMaster(PASSPHRASE, SALT, DEFAULT_KDF);
    const expected = deriveKey(master, KEY_DOMAIN.dymmi, SALT);

    expect(domainKeyFrom(PASSPHRASE, header, KEY_DOMAIN.dymmi).equals(expected)).toBe(true);
  });

  it('never hands a companion the key that opens the vault', () => {
    const companion = domainKeyFrom(PASSPHRASE, header, KEY_DOMAIN.dymmi);

    expect(companion.equals(vaultKeyFrom(PASSPHRASE, header))).toBe(false);
    expect(companion).toHaveLength(32);
  });

  it('is stable across calls, so a companion store survives a restart', () => {
    const first = domainKeyFrom(PASSPHRASE, header, KEY_DOMAIN.dymmi);
    const second = domainKeyFrom(PASSPHRASE, header, KEY_DOMAIN.dymmi);

    expect(first.equals(second)).toBe(true);
  });

  it('changes with the salt — re-keying the vault orphans the companion store', () => {
    const rekeyed: VaultHeader = { ...header, salt: '10'.repeat(16) };
    const before = domainKeyFrom(PASSPHRASE, header, KEY_DOMAIN.dymmi);

    expect(domainKeyFrom(PASSPHRASE, rekeyed, KEY_DOMAIN.dymmi).equals(before)).toBe(false);
  });
});

/** No `daemon-main.js` exists beside the sources, so `startDaemon` gives up and
 * these exercise the local-derivation path the daemon usually covers. */
describe('companionKey without a keyring', () => {
  let dir: string;
  const prev = process.env[PASSPHRASE_ENV];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-companion-'));
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[PASSPHRASE_ENV];
    else process.env[PASSPHRASE_ENV] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('derives the companion key the daemon would have returned', async () => {
    createVault(dir, PASSPHRASE);
    process.env[PASSPHRASE_ENV] = PASSPHRASE;

    const key = await companionKey('dymmi', dir);

    expect(key.equals(domainKeyFrom(PASSPHRASE, readHeader(dir), KEY_DOMAIN.dymmi))).toBe(true);
  });

  it('rejects a wrong passphrase here, not as an unreadable companion store later', async () => {
    createVault(dir, PASSPHRASE);
    process.env[PASSPHRASE_ENV] = 'not the passphrase';

    await expect(companionKey('dymmi', dir)).rejects.toBeInstanceOf(VaultAuthError);
  });

  it('refuses a profile that was never sealed, since there is no master', async () => {
    process.env[PASSPHRASE_ENV] = PASSPHRASE;

    await expect(companionKey('dymmi', dir)).rejects.toThrow(/not sealed/);
  });

  it('refuses an unknown companion before touching the vault', async () => {
    createVault(dir, PASSPHRASE);
    process.env[PASSPHRASE_ENV] = PASSPHRASE;

    await expect(companionKey('vault', dir)).rejects.toThrow(/Unknown companion/);
  });
});
