import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VopsSshKeysService, OPS_KEY_NAME } from '../src/ssh-keys/vops-ssh-keys.service';

// Only filesystem + ssh-keygen are exercised here; injected deps are unused.
const svc = () => new VopsSshKeysService({} as any, {} as any, {} as any);

describe('ops key lifecycle', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-ops-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'test';
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  it('reserves the ops key names from the user-facing lifecycle', () => {
    expect(() => svc().create(OPS_KEY_NAME)).toThrow(/reserved/);
    expect(() => svc().create('vops-ops.next')).toThrow(/reserved/);
    expect(() => svc().import('vops-ops', { publicKey: 'ssh-ed25519 AAAA x' })).toThrow(/reserved/);
  });

  it('lazily generates an ops key with role ops and a tagged authorized_keys line', () => {
    const s = svc();
    const key = s.ensureOpsKey();
    expect(key.role).toBe('ops');
    expect(key.hasPrivateKey).toBe(true);

    const line = s.opsAuthorizedKeysLine();
    expect(line).toMatch(/^no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 \S+ vops-ops:[a-f0-9]+$/);
    // --from adds a source restriction
    expect(s.opsAuthorizedKeysLine('203.0.113.0/24')).toContain('from="203.0.113.0/24"');
  });

  it('the ops key is not the implicit interactive key, and appears with role ops in list', () => {
    const s = svc();
    s.create('laptop'); // a normal user key
    s.ensureOpsKey();
    const roles = Object.fromEntries(s.list().map((k) => [k.name, k.role]));
    expect(roles['laptop']).toBe('user');
    expect(roles[OPS_KEY_NAME]).toBe('ops');
    // keyPathFor() with no name resolves the single USER key, ignoring the ops key
    expect(s.keyPathFor()).toContain('laptop');
  });

  it('rotation ladder + promotion rename the local generations', () => {
    const s = svc();
    const cur = s.ensureOpsKey();
    const next = s.ensureNextOpsKey();
    expect(s.opsLadder()).toEqual(expect.arrayContaining([cur.privateKeyPath, next.privateKeyPath]));

    s.promoteNextOpsKey();
    // next was promoted to the canonical name; a prev generation now exists
    expect(fs.existsSync(path.join(dir, 'profiles', 'test', 'keys', `${OPS_KEY_NAME}.prev`))).toBe(true);
    expect(s.readOpsKey('.next')).toBeNull();
    expect(s.readOpsKey('')?.hasPrivateKey).toBe(true);
  });
});
