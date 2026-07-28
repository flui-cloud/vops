import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VaultAuthError } from '../src/lib/keyring/vault-format';
import { createVault, vaultExists, writeVault } from '../src/lib/keyring/vault-store';
import { PASSPHRASE_ENV, applyVaultEnv, ensureVaultUnlocked } from '../src/lib/keyring/unlock';
import { VaultLockedError, clearVaultKey, vaultKey } from '../src/lib/keyring/vault-session';
import { LocalConfigStore } from '../src/lib/config/local-config-store';

const PASSPHRASE = 'correct horse battery staple';

function tempProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vops-unlock-'));
}

describe('progressive unlock', () => {
  let dir: string;
  const prev = process.env[PASSPHRASE_ENV];

  beforeEach(() => {
    dir = tempProfile();
    clearVaultKey();
    delete process.env[PASSPHRASE_ENV];
  });

  afterEach(() => {
    clearVaultKey();
    if (prev === undefined) delete process.env[PASSPHRASE_ENV];
    else process.env[PASSPHRASE_ENV] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing at all when the profile has no vault', async () => {
    // The property that makes the unlock progressive: a profile that was never
    // sealed must never be asked for a passphrase, on any code path.
    await expect(ensureVaultUnlocked({ dir })).resolves.toBe('legacy');
    expect(vaultKey()).toBeNull();
  });

  it('derives from VOPS_PASSPHRASE without contacting a keyring', async () => {
    createVault(dir, PASSPHRASE);
    process.env[PASSPHRASE_ENV] = PASSPHRASE;
    await expect(ensureVaultUnlocked({ dir })).resolves.toBe('unlocked');
    expect(vaultKey()).toHaveLength(32);
  });

  it('rejects a wrong VOPS_PASSPHRASE at the unlock, not later', async () => {
    createVault(dir, PASSPHRASE);
    process.env[PASSPHRASE_ENV] = 'not the passphrase';
    await expect(ensureVaultUnlocked({ dir })).rejects.toBeInstanceOf(VaultAuthError);
    expect(vaultKey()).toBeNull();
  });

  it('reuses the key already held by this process', async () => {
    createVault(dir, PASSPHRASE);
    await ensureVaultUnlocked({ dir, passphrase: PASSPHRASE, noDaemon: true });
    const first = vaultKey();
    await ensureVaultUnlocked({ dir, passphrase: 'anything else', noDaemon: true });
    expect(vaultKey()).toBe(first);
  });

  it('works with no keyring at all, deriving locally', async () => {
    createVault(dir, PASSPHRASE);
    await expect(
      ensureVaultUnlocked({ dir, passphrase: PASSPHRASE, noDaemon: true }),
    ).resolves.toBe('unlocked');
  });
});

describe('vault env publication', () => {
  const names = ['VOPS_TEST_A', 'VOPS_TEST_B'];
  afterEach(() => {
    for (const name of names) delete process.env[name];
  });

  it('fills what the process lacks and never overwrites what it has', () => {
    process.env.VOPS_TEST_A = 'from-dotenv';
    const applied = applyVaultEnv({ VOPS_TEST_A: 'from-vault', VOPS_TEST_B: 'from-vault' });
    // .env stays the legacy override: importing must not change what resolves.
    expect(process.env.VOPS_TEST_A).toBe('from-dotenv');
    expect(process.env.VOPS_TEST_B).toBe('from-vault');
    expect(applied).toEqual(['VOPS_TEST_B']);
  });

  it('is applied by the unlock itself', async () => {
    const dir = tempProfile();
    const vault = createVault(dir, PASSPHRASE);
    writeVault(dir, { env: { VOPS_TEST_B: 'sealed' } }, vault.key, vault.header);
    clearVaultKey();
    await ensureVaultUnlocked({ dir, passphrase: PASSPHRASE, noDaemon: true });
    expect(process.env.VOPS_TEST_B).toBe('sealed');
    clearVaultKey();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('LocalConfigStore in vault mode', () => {
  let dir: string;
  let store: LocalConfigStore;
  const prevConfigDir = process.env.VOPS_CONFIG_DIR;

  beforeEach(() => {
    dir = tempProfile();
    process.env.VOPS_CONFIG_DIR = dir;
    store = new LocalConfigStore('p');
    clearVaultKey();
  });

  afterEach(() => {
    clearVaultKey();
    if (prevConfigDir === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the legacy format until a vault exists', () => {
    store.setToken('hetzner', 'tok-legacy');
    expect(store.sealed).toBe(false);
    expect(store.getToken('hetzner')).toBe('tok-legacy');
    expect(fs.existsSync(path.join(store.profileDir, '.key'))).toBe(true);
  });

  it('refuses to read a sealed profile without a key, instead of falling back', async () => {
    createVault(store.profileDir, PASSPHRASE);
    expect(store.sealed).toBe(true);
    expect(() => store.getToken('hetzner')).toThrow(VaultLockedError);

    await ensureVaultUnlocked({ dir: store.profileDir, passphrase: PASSPHRASE, noDaemon: true });
    store.setToken('hetzner', 'tok-sealed');
    expect(store.getToken('hetzner')).toBe('tok-sealed');
  });

  it('writes through the vault, never back to the legacy files', async () => {
    createVault(store.profileDir, PASSPHRASE);
    await ensureVaultUnlocked({ dir: store.profileDir, passphrase: PASSPHRASE, noDaemon: true });
    store.setCredentials('scaleway', { accessKey: 'ak', secretKey: 'sk' });
    expect(vaultExists(store.profileDir)).toBe(true);
    expect(fs.existsSync(path.join(store.profileDir, 'secrets.json.enc'))).toBe(false);
    expect(fs.existsSync(path.join(store.profileDir, '.key'))).toBe(false);
    expect(store.getCredentials('scaleway')).toEqual({ accessKey: 'ak', secretKey: 'sk' });
  });
});
