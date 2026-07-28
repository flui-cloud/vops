import { VopsHostShellService } from '../src/host-ops/host-shell.service';
import { OPS_KEY_NAME } from '../src/ssh-keys/vops-ssh-keys.service';
import { VopsHost } from '../src/hosts/host.model';

const OPS_KEY = { name: OPS_KEY_NAME, role: 'ops', hasPrivateKey: true, privateKeyPath: '/k/ops' };
const USER_KEY = { name: 'laptop', role: 'user', hasPrivateKey: true, privateKeyPath: '/k/laptop' };

const host = (over: Partial<VopsHost> = {}): VopsHost => ({
  name: 'vmi3399032', address: '109.123.252.6', user: 'root', port: 22,
  opsKeyInstalled: false, tags: [], addedAt: '2026-01-01T00:00:00.000Z', ...over,
});

function svc(h: VopsHost, keys: Array<{ name: string; privateKeyPath: string }> = [OPS_KEY, USER_KEY]) {
  const hosts = { show: () => h };
  const keySvc = { list: () => keys, keyPathFor: (name?: string) => keys.find((k) => k.name === name)?.privateKeyPath };
  return new VopsHostShellService(hosts as never, keySvc as never);
}

describe('VopsHostShellService — a host connects the way vops itself connects', () => {
  it('prefers the ops key when installed, even with no user key assigned', () => {
    const access = svc(host({ opsKeyInstalled: true })).access('vmi3399032');
    expect(access.argv).toContain('/k/ops');
    expect(access.command.startsWith('ssh -i /k/ops')).toBe(true);
  });

  it('falls back to the assigned user key when the ops key is not installed', () => {
    const access = svc(host({ userKeyName: 'laptop' })).access('vmi3399032');
    expect(access.argv).toContain('/k/laptop');
  });

  it('opens a login shell — no remote command, so ssh runs the target’s own shell', () => {
    const access = svc(host({ opsKeyInstalled: true })).access('vmi3399032');
    expect(access.argv[access.argv.length - 1]).toBe('root@109.123.252.6');
    expect(access.argv).toContain('-t');
  });

  it('surfaces the equivalent vops CLI invocation', () => {
    const access = svc(host({ opsKeyInstalled: true })).access('vmi3399032');
    expect(access.cli).toBe('vops host ssh vmi3399032');
    expect(access.user).toBe('root');
    expect(access.address).toBe('109.123.252.6');
  });

  it('throws a friendly error when neither key is usable', () => {
    expect(() => svc(host(), []).access('vmi3399032')).toThrow(/No usable key/);
  });
});
