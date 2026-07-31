import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpException } from '@nestjs/common';
import { VaultController } from '../src/local-api/vault.controller';
import { UnlockThrottle } from '../src/lib/keyring/unlock-throttle';
import { KEY_DOMAIN, deriveKey } from '../src/lib/keyring/derive';
import { KeyringServer } from '../src/lib/keyring/keyring-server';
import { DaemonHandle, listenKeyring } from '../src/lib/keyring/keyring-daemon';
import { keyringCookie } from '../src/lib/keyring/keyring-cookie';
import { keyringSocket } from '../src/lib/keyring/socket-path';
import { createVault, readHeader, readWith } from '../src/lib/keyring/vault-store';
import { clearVaultKey, vaultKey } from '../src/lib/keyring/vault-session';
import { PASSPHRASE_ENV } from '../src/lib/keyring/unlock';

const PASSPHRASE = 'correct horse battery staple';
const WRONG = 'not the passphrase';

/** The message the daemon and the vault format would otherwise surface. Neither
 * may reach the client: one 401 string for every failed attempt. */
const LEAKY = /passphrase \(the vault did not authenticate\)|Vault contents/i;

let clock = 0;
const throttle = (): UnlockThrottle => new UnlockThrottle({ now: () => clock });

interface ErrorBody {
  statusCode: number;
  message: string;
  retryInMs: number;
  failures: number;
}

async function statusOf(fn: () => Promise<unknown>): Promise<{ status: number; body: ErrorBody }> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HttpException) {
      return { status: e.getStatus(), body: e.getResponse() as ErrorBody };
    }
    throw e;
  }
  throw new Error('expected the call to reject');
}

describe('vault unlock over the local API', () => {
  let base: string;
  let dir: string;
  const prevConfig = process.env.VOPS_CONFIG_DIR;
  const prevPass = process.env[PASSPHRASE_ENV];

  beforeEach(() => {
    clock = 1_000_000;
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-vaultapi-'));
    process.env.VOPS_CONFIG_DIR = base;
    delete process.env[PASSPHRASE_ENV];
    dir = path.join(base, 'profiles', 'default');
    fs.mkdirSync(dir, { recursive: true });
    clearVaultKey();
  });

  afterEach(() => {
    clearVaultKey();
    if (prevConfig === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevConfig;
    if (prevPass === undefined) delete process.env[PASSPHRASE_ENV];
    else process.env[PASSPHRASE_ENV] = prevPass;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reports the three vault states without unlocking anything', async () => {
    const c = new VaultController(throttle());
    expect((await c.status()).state).toBe('legacy');

    createVault(dir, PASSPHRASE);
    expect((await c.status()).state).toBe('locked');
    expect(vaultKey()).toBeNull();

    await c.unlock({ passphrase: PASSPHRASE });
    expect((await c.status()).state).toBe('unlocked');
  });

  it('refuses an empty passphrase before touching the vault', async () => {
    createVault(dir, PASSPHRASE);
    const c = new VaultController(throttle());
    const { status } = await statusOf(() => c.unlock({}));
    expect(status).toBe(400);
    // A missing field is not a guess: it must not consume an attempt.
    expect((await c.status()).throttle.failures).toBe(0);
  });

  it('answers 401 with a fixed message when no keyring is running', async () => {
    createVault(dir, PASSPHRASE);
    const c = new VaultController(throttle());

    const { status, body } = await statusOf(() => c.unlock({ passphrase: WRONG }));
    expect(status).toBe(401);
    expect(body.message).toBe('Wrong passphrase.');
    expect(body.message).not.toMatch(LEAKY);
    expect(body.failures).toBe(1);
    expect(body.retryInMs).toBe(1_000);
    expect(vaultKey()).toBeNull();
  });

  it('holds off a second attempt inside the backoff window', async () => {
    createVault(dir, PASSPHRASE);
    const c = new VaultController(throttle());
    await statusOf(() => c.unlock({ passphrase: WRONG }));

    const { status, body } = await statusOf(() => c.unlock({ passphrase: PASSPHRASE }));
    expect(status).toBe(429);
    expect(body.retryInMs).toBe(1_000);
    // The correct passphrase was refused unread, so the vault is still sealed.
    expect(vaultKey()).toBeNull();

    clock += 1_000;
    await c.unlock({ passphrase: PASSPHRASE });
    expect(vaultKey()).not.toBeNull();
  });

  it('clears the failure count once the right passphrase lands', async () => {
    createVault(dir, PASSPHRASE);
    const c = new VaultController(throttle());
    await statusOf(() => c.unlock({ passphrase: WRONG }));
    clock += 1_000;
    const res = await c.unlock({ passphrase: PASSPHRASE });
    expect(res.state).toBe('unlocked');
    expect(res.throttle).toEqual({ failures: 0, retryInMs: 0 });
  });

  it('locks again on request', async () => {
    createVault(dir, PASSPHRASE);
    const c = new VaultController(throttle());
    await c.unlock({ passphrase: PASSPHRASE });
    expect((await c.lock()).state).toBe('locked');
    expect(vaultKey()).toBeNull();
  });
});

/**
 * The second shape a wrong passphrase arrives in. A running keyring answers
 * `bad-passphrase` over the socket, which used to surface as a plain Error and
 * therefore as a 502 — indistinguishable, to the dashboard, from a broken server.
 */
describe('vault unlock with a keyring listening', () => {
  let base: string;
  let dir: string;
  let daemon: DaemonHandle;
  const prevConfig = process.env.VOPS_CONFIG_DIR;

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-vaultkr-'));
    process.env.VOPS_CONFIG_DIR = base;
    dir = path.join(base, 'profiles', 'default');
    fs.mkdirSync(dir, { recursive: true });
    createVault(dir, PASSPHRASE);

    const server = new KeyringServer({
      cookie: keyringCookie(dir),
      ttlMs: 60_000,
      readHeader: () => {
        const header = readHeader(dir);
        return { salt: Buffer.from(header.salt, 'hex'), kdf: header.kdf };
      },
      verify: (master) => {
        const salt = Buffer.from(readHeader(dir).salt, 'hex');
        const key = deriveKey(master, KEY_DOMAIN.vault, salt);
        try {
          readWith(dir, key);
        } finally {
          key.fill(0);
        }
      },
    });
    daemon = await listenKeyring(server, keyringSocket(dir));
  });

  afterAll(async () => {
    await daemon?.close();
    clearVaultKey();
    if (prevConfig === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevConfig;
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    clock = 2_000_000;
    clearVaultKey();
  });

  it('maps the daemon rejection to 401, not 502, and leaks nothing', async () => {
    const c = new VaultController(throttle());
    const { status, body } = await statusOf(() => c.unlock({ passphrase: WRONG }));
    expect(status).toBe(401);
    expect(body.message).toBe('Wrong passphrase.');
    expect(body.message).not.toMatch(LEAKY);
  });

  it('unlocks through the daemon and leaves a session behind', async () => {
    const c = new VaultController(throttle());
    const res = await c.unlock({ passphrase: PASSPHRASE });
    expect(res.state).toBe('unlocked');
    expect(res.keyring).toMatchObject({ listening: true, unlocked: true });
  });
});
