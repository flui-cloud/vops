import { VopsHostConnService } from '../src/host-ops/vops-host-conn.service';
import { OPS_KEY_NAME } from '../src/ssh-keys/vops-ssh-keys.service';
import { VopsHost } from '../src/hosts/host.model';

const USER_KEY = { name: 'laptop', role: 'user', hasPrivateKey: true, privateKeyPath: '/k/laptop', publicKey: 'ssh-ed25519 AAAA laptop' };
const OPS_KEY = { name: OPS_KEY_NAME, role: 'ops', hasPrivateKey: true, privateKeyPath: '/k/ops', publicKey: 'ssh-ed25519 BBBB ops' };

/** resolveKey only reads the key store; hosts/ssh are irrelevant to provenance. */
function svc(userKey: unknown = USER_KEY) {
  const keys = { list: () => [USER_KEY, OPS_KEY], resolveUserKey: () => userKey };
  return new VopsHostConnService({} as never, keys as never, {} as never);
}

const host = (over: Partial<VopsHost> = {}): VopsHost => ({
  name: 'h', address: '203.0.113.9', user: 'root', port: 22,
  opsKeyInstalled: false, tags: [], addedAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('VopsHostConnService.resolveKey — key provenance', () => {
  it('no userKeyName → the sole-key fallback is marked default, never passed off as a choice', () => {
    const rk = svc().resolveKey(host());
    expect(rk.keyName).toBe('laptop');
    expect(rk.keySource).toBe('default');
  });

  it('explicit userKeyName → assigned', () => {
    const rk = svc().resolveKey(host({ userKeyName: 'laptop' }));
    expect(rk.keyName).toBe('laptop');
    expect(rk.keySource).toBe('assigned');
  });

  it('ops key installed → assigned (deliberately installed, not a guess)', () => {
    const rk = svc().resolveKey(host({ opsKeyInstalled: true }));
    expect(rk.keyKind).toBe('ops');
    expect(rk.keySource).toBe('assigned');
  });

  it('no usable key → none, and no provenance to claim', () => {
    const rk = svc(null).resolveKey(host());
    expect(rk.keyKind).toBe('none');
    expect(rk.keySource).toBeUndefined();
  });
});
