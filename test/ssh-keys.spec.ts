import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VopsSshKeysService } from '../src/ssh-keys/vops-ssh-keys.service';

// import/list/read/remove touch only the filesystem — the injected deps are unused there.
const svc = () => new VopsSshKeysService({} as any, {} as any, {} as any);

describe('VopsSshKeysService.import', () => {
  let dir: string;
  let extPriv: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-ssh-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'test';
    // A private key that lives OUTSIDE the keystore, to import by reference.
    extPriv = path.join(dir, 'external_id');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', extPriv, '-N', '', '-C', 'ext'], {
      stdio: 'ignore',
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  it('imports a private key BY REFERENCE without copying the secret', () => {
    const key = svc().import('laptop', { privateKeyPath: extPriv });
    expect(key.hasPrivateKey).toBe(true);
    expect(key.imported).toBe(true);
    expect(key.privateKeyPath).toBe(extPriv); // points at the original, not the keystore
    // the keystore must NOT contain a copy of the private key
    const keystorePriv = path.join(dir, 'profiles', 'test', 'keys', 'laptop');
    expect(fs.existsSync(keystorePriv)).toBe(false);
    // but the derived public key and the reference sidecar are stored
    expect(fs.existsSync(`${keystorePriv}.pub`)).toBe(true);
    expect(fs.readFileSync(`${keystorePriv}.path`, 'utf8').trim()).toBe(extPriv);
  });

  it('imports a public key string (public-only, not usable for ssh)', () => {
    const pub = fs.readFileSync(`${extPriv}.pub`, 'utf8').trim();
    const key = svc().import('deploy', { publicKey: pub });
    expect(key.hasPrivateKey).toBe(false);
    expect(key.publicKey).toBe(pub);
  });

  it('imports a public key from a file path', () => {
    const key = svc().import('fromfile', { publicKeyPath: `${extPriv}.pub` });
    expect(key.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
  });

  it('rejects a non-key string', () => {
    expect(() => svc().import('bad', { publicKey: 'not a key' })).toThrow();
  });

  it('rejects a duplicate name', () => {
    svc().import('dup', { publicKeyPath: `${extPriv}.pub` });
    expect(() => svc().import('dup', { publicKeyPath: `${extPriv}.pub` })).toThrow();
  });

  it('rejects when nothing is provided', () => {
    expect(() => svc().import('empty', {})).toThrow();
  });

  it('remove() drops the pub + reference but never the external private key', () => {
    const s = svc();
    s.import('laptop', { privateKeyPath: extPriv });
    s.remove('laptop');
    expect(fs.existsSync(extPriv)).toBe(true); // the user's own key survives
    expect(fs.existsSync(path.join(dir, 'profiles', 'test', 'keys', 'laptop.pub'))).toBe(false);
  });
});
