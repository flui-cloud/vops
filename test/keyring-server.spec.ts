import { DEFAULT_KDF, KEY_DOMAIN, deriveKey, deriveMaster } from '../src/lib/keyring/derive';
import { KeyringServer } from '../src/lib/keyring/keyring-server';
import { decodeRequest, encodeRequest } from '../src/lib/keyring/protocol';
import { keyringSocket } from '../src/lib/keyring/socket-path';
import { VaultAuthError } from '../src/lib/keyring/vault-format';

const SALT = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const COOKIE = 'cookie-abc';
const TTL = 60_000;
const PASSPHRASE = 'correct horse battery staple';
const goodMaster = deriveMaster(PASSPHRASE, SALT);

function makeServer(now: () => number = () => 0) {
  const onLock = jest.fn();
  const server = new KeyringServer({
    cookie: COOKIE,
    ttlMs: TTL,
    now,
    onLock,
    readHeader: () => ({ salt: SALT, kdf: DEFAULT_KDF }),
    verify: (m) => {
      if (!m.equals(goodMaster)) throw new VaultAuthError();
    },
  });
  return { server, onLock };
}

describe('keyring authorisation', () => {
  it('rejects every op when the cookie is wrong', () => {
    const { server } = makeServer();
    for (const op of ['status', 'unlock', 'key', 'lock'] as const) {
      const res = server.handle({ op, cookie: 'wrong', passphrase: PASSPHRASE, domain: KEY_DOMAIN.vault });
      expect(res).toMatchObject({ ok: false, code: 'unauthorized' });
    }
  });

  it('does not leak whether it is unlocked to an unauthorised caller', () => {
    const { server } = makeServer();
    server.handle({ op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE });
    expect(server.handle({ op: 'status', cookie: 'wrong' })).toMatchObject({ ok: false, code: 'unauthorized' });
  });
});

describe('unlock', () => {
  it('refuses a wrong passphrase and stays locked', () => {
    const { server } = makeServer();
    expect(server.handle({ op: 'unlock', cookie: COOKIE, passphrase: 'nope' })).toMatchObject({
      ok: false,
      code: 'bad-passphrase',
    });
    expect(server.unlocked).toBe(false);
    expect(server.handle({ op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault })).toMatchObject({ code: 'locked' });
  });

  it('accepts the right passphrase and then serves derived keys', () => {
    const { server } = makeServer();
    expect(server.handle({ op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE })).toMatchObject({ ok: true });
    const res = server.handle({ op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault });
    expect(res).toMatchObject({ ok: true, op: 'key' });
    expect((res as { key: string }).key).toBe(deriveKey(goodMaster, KEY_DOMAIN.vault, SALT).toString('hex'));
  });

  it('never returns the master itself, only domain-derived keys', () => {
    const { server } = makeServer();
    server.handle({ op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE });
    for (const domain of Object.values(KEY_DOMAIN)) {
      const res = server.handle({ op: 'key', cookie: COOKIE, domain }) as { key: string };
      expect(res.key).not.toBe(goodMaster.toString('hex'));
    }
  });
});

describe('ttl', () => {
  it('locks itself once the window passes', () => {
    let clock = 0;
    const { server, onLock } = makeServer(() => clock);
    server.handle({ op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE });

    clock = TTL - 1;
    expect(server.unlocked).toBe(true);

    clock = TTL;
    expect(server.unlocked).toBe(false);
    expect(onLock).toHaveBeenCalled();
    expect(server.handle({ op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault })).toMatchObject({ code: 'locked' });
  });

  it('slides the window on every authorised use', () => {
    let clock = 0;
    const { server } = makeServer(() => clock);
    server.handle({ op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE });

    clock = TTL - 10;
    server.handle({ op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault });

    clock = TTL + 10; // past the original expiry, inside the refreshed one
    expect(server.unlocked).toBe(true);
  });

  it('reports the expiry through status', () => {
    let clock = 1000;
    const { server } = makeServer(() => clock);
    expect(server.handle({ op: 'status', cookie: COOKIE })).toMatchObject({ unlocked: false, expiresAt: null });
    server.handle({ op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE });
    expect(server.handle({ op: 'status', cookie: COOKIE })).toMatchObject({
      unlocked: true,
      expiresAt: 1000 + TTL,
    });
  });
});

describe('explicit lock', () => {
  it('wipes the master immediately', () => {
    const { server, onLock } = makeServer();
    server.handle({ op: 'unlock', cookie: COOKIE, passphrase: PASSPHRASE });
    expect(server.handle({ op: 'lock', cookie: COOKIE })).toMatchObject({ ok: true, op: 'lock' });
    expect(server.unlocked).toBe(false);
    expect(onLock).toHaveBeenCalledTimes(1);
  });
});

describe('protocol framing', () => {
  it('round-trips a valid request', () => {
    const line = encodeRequest({ op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault });
    expect(line.endsWith('\n')).toBe(true);
    expect(decodeRequest(line.trim())).toEqual({ op: 'key', cookie: COOKIE, domain: KEY_DOMAIN.vault });
  });

  it('rejects malformed input instead of throwing', () => {
    expect(decodeRequest('not json')).toMatchObject({ error: expect.stringContaining('JSON') });
    expect(decodeRequest('[]')).toMatchObject({ error: expect.stringContaining('object') });
    expect(decodeRequest('{"op":"nope","cookie":"c"}')).toMatchObject({ error: expect.stringContaining('Unknown op') });
    expect(decodeRequest('{"op":"status"}')).toMatchObject({ error: expect.stringContaining('cookie') });
    expect(decodeRequest('{"op":"unlock","cookie":"c"}')).toMatchObject({ error: expect.stringContaining('passphrase') });
    expect(decodeRequest('{"op":"key","cookie":"c","domain":"evil"}')).toMatchObject({
      error: expect.stringContaining('domain'),
    });
    expect(decodeRequest('{"op":"status","cookie":"c"}'.padEnd(70_000, ' '))).toMatchObject({
      error: expect.stringContaining('too large'),
    });
  });

  it('does not let an unknown domain through to the server', () => {
    const decoded = decodeRequest('{"op":"key","cookie":"cookie-abc","domain":"../../etc/passwd"}');
    expect(decoded).toHaveProperty('error');
  });
});

describe('socket path', () => {
  it('uses a named pipe on Windows, with no directory to create', () => {
    const loc = keyringSocket('C:\\Users\\me\\.config\\vops\\profiles\\default', 'win32');
    expect(loc.socketPath.startsWith('\\\\.\\pipe\\vops-keyring-')).toBe(true);
    expect(loc.socketPath).not.toContain('/');
    expect(loc.dir).toBeUndefined();
  });

  it('uses a socket inside the profile dir on POSIX', () => {
    const loc = keyringSocket('/home/me/.config/vops/profiles/default', 'linux');
    expect(loc.socketPath).toBe('/home/me/.config/vops/profiles/default/keyring.sock');
    expect(loc.dir).toBe('/home/me/.config/vops/profiles/default');
  });

  it('falls back to a short temp path when sun_path would overflow', () => {
    const deep = '/home/me/' + 'nested/'.repeat(20) + 'profiles/default';
    const loc = keyringSocket(deep, 'darwin');
    expect(Buffer.byteLength(loc.socketPath)).toBeLessThanOrEqual(100);
    expect(loc.socketPath).not.toContain('nested');
    expect(loc.dir).toBeDefined();
  });

  it('gives different profiles different sockets, stably', () => {
    const a = keyringSocket('/home/me/.config/vops/profiles/default', 'linux');
    const b = keyringSocket('/home/me/.config/vops/profiles/work', 'linux');
    expect(a.socketPath).not.toBe(b.socketPath);
    expect(keyringSocket('/home/me/.config/vops/profiles/default', 'linux')).toEqual(a);
  });
});
