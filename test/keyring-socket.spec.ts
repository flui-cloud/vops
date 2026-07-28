import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_KDF, KEY_DOMAIN, deriveMaster } from '../src/lib/keyring/derive';
import { KeyringServer } from '../src/lib/keyring/keyring-server';
import { DaemonHandle, listenKeyring } from '../src/lib/keyring/keyring-daemon';
import { KeyringUnavailableError, keyringRequest } from '../src/lib/keyring/keyring-client';
import { keyringSocket } from '../src/lib/keyring/socket-path';
import { VaultAuthError } from '../src/lib/keyring/vault-format';

/**
 * End-to-end over a real socket — this is what proves the keyring design works
 * on this platform, not just in a unit test with a fake transport.
 */
const SALT = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const COOKIE = 'cookie-abc';
const PASSPHRASE = 'correct horse battery staple';
const goodMaster = deriveMaster(PASSPHRASE, SALT);

describe('keyring over a real socket', () => {
  let dir: string;
  let daemon: DaemonHandle;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-kr-'));
    const server = new KeyringServer({
      cookie: COOKIE,
      ttlMs: 60_000,
      readHeader: () => ({ salt: SALT, kdf: DEFAULT_KDF }),
      verify: (m) => {
        if (!m.equals(goodMaster)) throw new VaultAuthError();
      },
    });
    daemon = await listenKeyring(server, keyringSocket(dir));
  });

  afterAll(async () => {
    await daemon?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the socket inside a 0700 directory', () => {
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(daemon.socketPath).isSocket()).toBe(true);
  });

  it('answers status while locked', async () => {
    await expect(keyringRequest(daemon.socketPath, { op: 'status', cookie: COOKIE })).resolves.toMatchObject({
      ok: true,
      unlocked: false,
    });
  });

  it('rejects a bad cookie across the wire', async () => {
    await expect(keyringRequest(daemon.socketPath, { op: 'status', cookie: 'wrong' })).resolves.toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
  });

  it('unlocks and serves a derived key, then locks again', async () => {
    await expect(
      keyringRequest(daemon.socketPath, { op: 'unlock', cookie: COOKIE, passphrase: 'wrong' }),
    ).resolves.toMatchObject({ ok: false, code: 'bad-passphrase' });

    await expect(
      keyringRequest(daemon.socketPath, { op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE }),
    ).resolves.toMatchObject({ ok: true });

    const res = await keyringRequest(daemon.socketPath, { op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault });
    expect(res).toMatchObject({ ok: true, op: 'key' });
    expect((res as { key: string }).key).toHaveLength(64);
    expect((res as { key: string }).key).not.toBe(goodMaster.toString('hex'));

    await keyringRequest(daemon.socketPath, { op: 'lock', cookie: COOKIE });
    await expect(keyringRequest(daemon.socketPath, { op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault }))
      .resolves.toMatchObject({ code: 'locked' });
  });

  it('survives a malformed line without dying', async () => {
    const reply = await new Promise<string>((resolve) => {
      const c = net.connect(daemon.socketPath, () => c.end('this is not json\n'));
      let buf = '';
      // The response must be consumed: a socket with no 'data' listener stays
      // paused, so the peer's FIN is never processed and 'close' never fires.
      c.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      c.on('close', () => resolve(buf));
      c.on('error', () => resolve(buf));
    });
    expect(JSON.parse(reply)).toMatchObject({ ok: false, code: 'bad-request' });
    await expect(keyringRequest(daemon.socketPath, { op: 'status', cookie: COOKIE })).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('stale socket handling', () => {
  it('reports unavailable when nothing is listening', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-kr-none-'));
    await expect(keyringRequest(path.join(dir, 'keyring.sock'), { op: 'status', cookie: COOKIE })).rejects.toThrow(
      KeyringUnavailableError,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reclaims a leftover socket file from a crashed daemon', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-kr-stale-'));
    const loc = keyringSocket(dir);
    fs.writeFileSync(loc.socketPath, ''); // not a socket, just a leftover file
    const server = new KeyringServer({ cookie: COOKIE, ttlMs: 1000, readHeader: () => ({ salt: SALT, kdf: DEFAULT_KDF }) });
    const d = await listenKeyring(server, loc);
    await expect(keyringRequest(d.socketPath, { op: 'status', cookie: COOKIE })).resolves.toMatchObject({ ok: true });
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to hijack a socket a live keyring already owns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-kr-live-'));
    const loc = keyringSocket(dir);
    const mk = () => new KeyringServer({ cookie: COOKIE, ttlMs: 1000, readHeader: () => ({ salt: SALT, kdf: DEFAULT_KDF }) });
    const first = await listenKeyring(mk(), loc);
    await expect(listenKeyring(mk(), loc)).rejects.toThrow(/already listening/);
    await first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
